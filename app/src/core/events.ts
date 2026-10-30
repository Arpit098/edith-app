// Mirrors contracts/events.md. Change that file first, then this one.

export type Origin = 'telegram' | 'app' | 'terminal' | 'system';
export type Lane = 'main' | 'side';

export interface EdithEvent<T = Record<string, unknown>> {
  type: string; // e.g. "turn.done"
  ts: number;
  session_id?: string | null;
  origin: Origin;
  data: T;
}

export interface ReplyButton {
  label: string;
  action: string; // "<prefix>:<args…>", at most 64 bytes
}
export type ButtonRows = ReplyButton[][];

/**
 * `data` of each event type in the contract. Wire data is untrusted: read it through core/guards.
 * Live-view events (message.*, tool.*, file.diff) also carry `cursor`: "<session_id>:<offset>",
 * opaque, compared only by equality or passed back to the history API.
 */
export interface EventDataMap {
  // Frontend messages (contracts/events.md, "Messages from Arpit"): accepted at once with the POST's ref; clean text.
  'message.user': { text: string; voice: boolean; cursor: string; ref?: string; delivery?: 'main' | 'queued' | 'side_lane'; lane?: 'main' | 'queued' | 'side'; attachments?: string[]; replying_to?: string | null };
  'message.assistant': { text: string; cursor: string; lane?: Lane; ref?: string; files?: string[] };
  'tool.call': { id: string; name: string; summary: string; cursor: string };
  'tool.result': { id: string; name: string; ok: boolean; summary: string; cursor: string };
  'file.diff': { id: string; path: string; diff: string; cursor: string };
  'turn.started': { ref: string; lane?: Lane };
  'turn.done': { ref: string; text: string; display_text?: string; files?: string[]; reaction?: string | null; steps: number; elapsed: number; lane?: Lane; is_error?: boolean; subtype?: string };
  'turn.stopped': { ref: string; lane?: Lane | 'queued' };
  'turn.queued': { ref: string; position: number };
  'turn.progress': { ref: string; lane: Lane; steps: number; step: string; elapsed: number };
  'turn.failed': { ref: string; reason: string; detail: string; lane?: Lane; code?: number; stderr?: string };
  'turn.retrying': { ref: string; lane: Lane; reason: string };
  'permission.request': { id: string; tool: string; detail: string; ref: string | null; lane: Lane | null };
  'permission.resolved': { id: string; decision: 'allow' | 'deny' | 'gone'; ref: string | null; lane: Lane | null };
  'session.changed': { session_id: string; title: string | null; source: string };
  'session.switched': { ref: string; result: 'ok' | 'already' | 'busy' | 'missing' | 'failed'; session_id: string | null };
  'lane.status': { main: 'idle' | 'busy'; side: number; queued: number };
  'reminder.due': { id: string; text: string; every: string | null; due: number; late: boolean };
  'message.system': { text: string; buttons?: ButtonRows; key?: string; ref?: string };
  'message.buttons_cleared': { key: string };
  'command.reply': { ref: string; text: string; buttons?: ButtonRows };
  // How Claude took a frontend message, and the reaction Telegram would show (contracts/events.md):
  'message.delivered': { ref: string; delivery: 'main' | 'mid_turn' | 'side_lane'; rid: string };
  'message.reaction': { ref: string; emoji: string }; // EDITH's reaction on Arpit's message; the latest wins
  // A Claude account switch's progress (contracts/accounts.md); read it through accountSwitchFrom (core/api):
  'accounts.switch': Record<string, unknown>;
  // App-local events (never sent by the server):
  'app.connected': { first: boolean }; // core/connection.ts: the stream (re)opened; resync what may be missed
  'app.voice': { state: 'listening' | 'speaking' | 'idle' }; // the voice feature (Phase 3): mic or TTS active
  'app.screen': { name: string }; // shell/: the screen now on top (e.g. "live", "approvals")
  'app.open': { screen: string }; // a feature asks the shell to open a screen (e.g. Settings → "wakeword")
}

export type EventType = keyof EventDataMap;
export type TypedEvent<K extends EventType> = EdithEvent<Partial<EventDataMap[K]>>;
export type EventHandler = (event: EdithEvent) => void;

/** Glob-style subscribe ("turn.*", "*"). A failing handler is logged and never blocks the others. */
export class EventBus {
  private subs: { pattern: RegExp; handler: EventHandler; owner: string }[] = [];

  subscribe(pattern: string, handler: EventHandler, owner = '?'): () => void {
    const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
    const sub = { pattern: re, handler, owner };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }

  /** Typed subscribe to one event type. Fields are Partial: the server may omit any of them. */
  on<K extends EventType>(type: K, handler: (event: TypedEvent<K>) => void, owner = '?'): () => void {
    return this.subscribe(type, handler as EventHandler, owner);
  }

  publish(event: EdithEvent): void {
    for (const { pattern, handler, owner } of [...this.subs]) {
      if (!pattern.test(event.type)) continue;
      try {
        handler(event);
      } catch (e) {
        console.warn(`[edith] handler from ${owner} failed on ${event.type}`, e);
      }
    }
  }
}

const ORIGINS = new Set<Origin>(['telegram', 'app', 'terminal', 'system']);

/** A wire object (stream frame or history entry) -> an event, or null if it isn't one. */
export function toEvent(obj: unknown): EdithEvent | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.type !== 'string' || !o.type) return null;
  return {
    type: o.type,
    ts: typeof o.ts === 'number' ? o.ts : Date.now() / 1000,
    session_id: typeof o.session_id === 'string' ? o.session_id : null,
    origin: ORIGINS.has(o.origin as Origin) ? (o.origin as Origin) : 'system',
    data: typeof o.data === 'object' && o.data !== null && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : {},
  };
}

/** The transcript cursor of a live-view event, or null for other events. */
export function cursorOf(event: EdithEvent): string | null {
  const c = event.data.cursor;
  return typeof c === 'string' && c ? c : null;
}

/** An app-local event (origin "system"), e.g. app.connected. */
export function localEvent<K extends EventType>(type: K, data: EventDataMap[K]): EdithEvent {
  return { type, ts: Date.now() / 1000, session_id: null, origin: 'system', data: data as unknown as Record<string, unknown> };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
