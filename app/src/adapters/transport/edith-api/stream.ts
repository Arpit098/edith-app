// The live /v1/stream: exactly one WebSocket, shared by every listener.
//
// - Reconnects on its own with exponential backoff + jitter; a rejected token (401) stops retrying.
// - Heartbeat: every `heartbeatMs` it sends {"type":"ping"} and the server answers {"type":"pong"}
//   (contracts/events.md). JS never sees WebSocket protocol pings, and OkHttp (Android) runs with no
//   read timeout or ping interval, so this is how a dead link gets noticed: once a pong has been
//   seen, 2.5 heartbeats with nothing inbound force a reconnect. (Before the first pong the watchdog
//   stays off, so an older server that ignores pings isn't mistaken for a dead one.)
// - Battery: after `backgroundGraceMs` in the background the socket closes; coming back to the
//   foreground reconnects at once (and listeners resync on the "open" status). While someone holds
//   it open (holdOpen(): the live status during a task or an approval), it stays connected.

import { toEvent, type EdithEvent } from '../../../core/events';
import type { ServerConfig, StreamStatus } from '../../../core/ports';
import { backoffDelay, type Backoff } from '../../../common/backoff';

export interface WebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((e: { data?: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onclose: ((e: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface AppStateLike {
  currentState: string | null;
  addEventListener(type: 'change', listener: (state: string) => void): { remove(): void };
}

export interface StreamOptions {
  connect: WebSocketFactory;
  appState?: AppStateLike;
  heartbeatMs: number;
  connectTimeoutMs: number;
  backgroundGraceMs: number;
  backoff: Backoff;
  random?: () => number;
}

interface Listener {
  onEvent: (event: EdithEvent) => void;
  onStatus?: (status: StreamStatus) => void;
}

const OPEN = 1;
const PING = JSON.stringify({ type: 'ping' });

export function streamUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/i, 'ws') + '/v1/stream';
}

/** One wire message -> an event, 'pong' for the server's answer to our ping, or null if malformed. */
export function parseFrame(data: unknown): EdithEvent | 'pong' | null {
  if (typeof data !== 'string') return null;
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return null;
  }
  const event = toEvent(obj);
  return event?.type === 'pong' ? 'pong' : event;
}

export class EventStream {
  private config: ServerConfig | null = null;
  private readonly listeners = new Set<Listener>();
  private ws: WebSocketLike | null = null;
  private attempt = 0;
  private paused = false; // in the background past the grace period
  private lastInbound = 0;
  private pongSeen = false;
  private status: StreamStatus = { state: 'idle', retryInMs: null, error: null };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private appStateSub: { remove(): void } | null = null;
  private holds = 0;
  private inBackground = false;

  constructor(private readonly opts: StreamOptions) {}

  configure(config: ServerConfig | null): void {
    this.config = config;
    this.pongSeen = false;
    this.attempt = 0;
    this.restart();
  }

  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    const before = this.status;
    if (this.listeners.size === 1) {
      this.appStateSub = this.opts.appState?.addEventListener('change', (s) => this.onAppState(s)) ?? null;
      this.paused = false;
      this.restart();
    }
    if (this.status === before) listener.onStatus?.(this.status); // tell a new listener where things stand
    return () => {
      if (!this.listeners.delete(listener) || this.listeners.size) return;
      this.appStateSub?.remove();
      this.appStateSub = null;
      this.clearGrace();
      this.restart(); // nobody listens: closes the socket and goes idle
    };
  }

  reconnect(): void {
    this.attempt = 0;
    this.restart();
  }

  private get wanted(): boolean {
    return this.config !== null && this.listeners.size > 0 && !this.paused;
  }

  private restart(): void {
    this.drop();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.wanted) this.open();
    else this.setStatus({ state: 'idle', retryInMs: null, error: null });
  }

  private open(): void {
    const config = this.config!;
    this.setStatus({ state: 'connecting', retryInMs: null, error: null });
    let ws: WebSocketLike;
    try {
      ws = this.opts.connect(streamUrl(config.baseUrl), { Authorization: `Bearer ${config.token}` });
    } catch (e) {
      this.closed(e instanceof Error ? e.message : String(e));
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectTimer();
      this.attempt = 0;
      this.lastInbound = Date.now();
      this.heartbeat = setInterval(() => this.beat(), this.opts.heartbeatMs);
      this.setStatus({ state: 'open', retryInMs: null, error: null });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastInbound = Date.now();
      const event = parseFrame(e.data);
      if (event === 'pong') this.pongSeen = true;
      else if (event) for (const l of [...this.listeners]) l.onEvent(event);
    };
    ws.onerror = () => {}; // the reason arrives with onclose
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.drop();
      this.closed(e.reason || `connection closed (${e.code ?? '?'})`);
    };
    this.connectTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      this.drop();
      this.closed('timed out');
    }, this.opts.connectTimeoutMs);
  }

  private beat(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    if (this.pongSeen && Date.now() - this.lastInbound > this.opts.heartbeatMs * 2.5) {
      this.drop();
      this.closed('no heartbeat');
      return;
    }
    try {
      ws.send(PING);
    } catch {
      // a failing send shows up as onclose
    }
  }

  private closed(reason: string): void {
    if (/\b401\b/.test(reason)) {
      this.setStatus({ state: 'closed', retryInMs: null, error: 'unauthorized' });
      return;
    }
    if (!this.wanted) {
      this.setStatus({ state: 'idle', retryInMs: null, error: null });
      return;
    }
    const delay = backoffDelay(this.attempt++, this.opts.backoff, this.opts.random);
    this.setStatus({ state: 'closed', retryInMs: delay, error: reason });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.open();
    }, delay);
  }

  /** Detach and close the current socket (if any) so none of its callbacks fire again. */
  private drop(): void {
    this.clearConnectTimer();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close(1000, 'bye');
    } catch {
      // already closed
    }
  }

  /** Keep the socket in the background while held (e.g. the live status shows a running task). */
  holdOpen(): () => void {
    this.holds++;
    this.clearGrace();
    if (this.paused) {
      this.paused = false;
      this.reconnect();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      if (!this.holds && this.inBackground) this.startGrace();
    };
  }

  private onAppState(state: string): void {
    this.inBackground = state === 'background';
    if (state === 'active') {
      this.clearGrace();
      if (this.paused || this.status.state === 'closed') {
        this.paused = false;
        this.reconnect();
      }
    } else if (state === 'background' && !this.holds) {
      this.startGrace();
    }
  }

  private startGrace(): void {
    if (this.graceTimer || this.paused) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.paused = true;
      this.restart();
    }, this.opts.backgroundGraceMs);
  }

  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private setStatus(status: StreamStatus): void {
    const s = this.status;
    if (s.state === status.state && s.retryInMs === status.retryInMs && s.error === status.error) return;
    this.status = status;
    for (const l of [...this.listeners]) l.onStatus?.(status);
  }
}
