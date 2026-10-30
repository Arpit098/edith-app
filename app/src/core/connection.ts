// The one connection to edith: the saved server, the live stream feeding the bus, and its state.
// Features read `store` and never open a stream themselves.

import { ApiError, createApi } from './api';
import { type EventBus, localEvent } from './events';
import type { SecureStorage, ServerConfig, StreamStatus, Transport } from './ports';
import { createStore, type Store } from './store';

export const DEFAULT_PORT = 8787;
const KEY_URL = 'edith.baseUrl';
const KEY_TOKEN = 'edith.token';
const VERIFY_TIMEOUT_MS = 8000;

/** loading → unconfigured | connecting ⇄ open | offline; unauthorized when the token is rejected. */
export type LinkState = 'loading' | 'unconfigured' | 'connecting' | 'open' | 'offline' | 'unauthorized';

export interface ConnectionState {
  link: LinkState;
  baseUrl: string | null; // also kept after forget(), to prefill the connect form
  error: string | null;
  retryInMs: number | null;
}

/**
 * "edith", "100.1.2.3:8787", "http://edith:8787/" → "http://edith:8787".
 * Throws on anything that isn't a plain http(s) host[:port].
 */
export function normalizeBaseUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) throw new Error('Enter the server address');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  const m = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(?::(\d{1,5}))?$/i.exec(s);
  if (!m) throw new Error('Use an address like edith:8787 or 100.x.y.z:8787');
  const [, scheme, host, port] = m;
  const p = port ? Number(port) : DEFAULT_PORT;
  if (p < 1 || p > 65535) throw new Error('The port must be 1–65535');
  return `${scheme!.toLowerCase()}://${host!.toLowerCase()}:${p}`;
}

export class Connection {
  readonly store: Store<ConnectionState> = createStore<ConnectionState>({ link: 'loading', baseUrl: null, error: null, retryInMs: null });
  private unsubscribe: (() => void) | null = null;
  private openedBefore = false;

  constructor(
    private readonly transport: Transport,
    private readonly storage: SecureStorage,
    readonly bus: EventBus, // the shell publishes app-local events (app.screen) on it
  ) {}

  /** Restore the saved server at startup and start streaming from it. */
  async load(): Promise<void> {
    let baseUrl: string | null = null;
    let token: string | null = null;
    let error: string | null = null;
    try {
      [baseUrl, token] = await Promise.all([this.storage.get(KEY_URL), this.storage.get(KEY_TOKEN)]);
    } catch (e) {
      error = `Couldn't read the saved token: ${e instanceof Error ? e.message : String(e)}`; // e.g. a reset Keystore
    }
    if (baseUrl && token) {
      this.start({ baseUrl, token });
    } else {
      this.store.set({ link: 'unconfigured', baseUrl, error, retryInMs: null });
    }
  }

  /**
   * Check the address and token with GET /v1/status, then save them and start streaming.
   * Used by the connect form (first run, or after forget()). Throws an Error with a message for
   * the form; nothing is saved on failure.
   */
  async connect(address: string, token: string): Promise<void> {
    const baseUrl = normalizeBaseUrl(address);
    const config = { baseUrl, token: token.trim() };
    if (!config.token) throw new Error('Enter the token');
    this.stop();
    this.transport.configure(config);
    try {
      await createApi(this.transport).status({ timeoutMs: VERIFY_TIMEOUT_MS });
    } catch (e) {
      this.transport.configure(null);
      throw new Error(e instanceof ApiError && e.status === 401 ? 'The server rejected this token' : connectError(e, baseUrl));
    }
    await Promise.all([this.storage.set(KEY_URL, baseUrl), this.storage.set(KEY_TOKEN, config.token)]);
    this.start(config);
  }

  /** Disconnect and delete the token (the address stays, to prefill the form). */
  async forget(): Promise<void> {
    this.stop();
    this.transport.configure(null);
    await this.storage.remove(KEY_TOKEN);
    this.store.set((s) => ({ link: 'unconfigured', baseUrl: s.baseUrl, error: null, retryInMs: null }));
  }

  /** Try the stream again now instead of waiting for the backoff. */
  retry(): void {
    this.transport.reconnect();
  }

  dispose(): void {
    this.stop();
  }

  private start(config: ServerConfig): void {
    this.stop();
    this.transport.configure(config);
    this.store.set({ link: 'connecting', baseUrl: config.baseUrl, error: null, retryInMs: null });
    this.unsubscribe = this.transport.stream(
      (event) => this.bus.publish(event),
      (status) => this.onStatus(status),
    );
  }

  private stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  private onStatus(status: StreamStatus): void {
    const link: LinkState =
      status.error === 'unauthorized'
        ? 'unauthorized'
        : status.state === 'open'
          ? 'open'
          : status.state === 'closed'
            ? 'offline'
            : 'connecting';
    this.store.set((s) => ({ ...s, link, error: status.error, retryInMs: status.retryInMs }));
    if (status.state === 'open') {
      // Events sent while we were away are gone: features resync their state on this.
      this.bus.publish(localEvent('app.connected', { first: !this.openedBefore }));
      this.openedBefore = true;
    }
  }
}

function connectError(e: unknown, baseUrl: string): string {
  if (e instanceof ApiError && e.status === 0) return `Can't reach ${baseUrl}. Is Tailscale on? (${e.message})`;
  if (e instanceof ApiError && e.status === 404) return `${baseUrl} doesn't look like the EDITH App API`;
  return e instanceof Error ? e.message : String(e);
}
