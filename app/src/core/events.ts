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

/** `data` of each event type in the contract. Wire data is untrusted: read it through core/guards. */
export interface EventDataMap {
  'message.user': { text: string; voice: boolean };
  'message.assistant': { text: string };
  'tool.call': { name: string; summary: string };
  'tool.result': { name: string; ok: boolean; summary: string };
  'file.diff': { path: string; diff: string };
  'turn.started': { ref: string; lane?: Lane };
  'turn.done': { ref: string; text: string; steps: number; elapsed: number; lane?: Lane; is_error?: boolean; subtype?: string };
  'turn.stopped': { ref: string; lane?: Lane | 'queued' };
  'turn.queued': { ref: string; position: number };
  'turn.progress': { ref: string; lane: Lane; steps: number; step: string; elapsed: number };
  'turn.failed': { ref: string; reason: string; detail: string; lane?: Lane; code?: number; stderr?: string };
  'turn.retrying': { ref: string; lane: Lane; reason: string };
  'permission.request': { id: string; tool: string; detail: string; ref: string | null; lane: Lane | null };
  'permission.resolved': { id: string; decision: 'allow' | 'deny' | 'gone'; ref: string | null; lane: Lane | null };
  'session.changed': { session_id: string; title: string | null; source: string };
  'lane.status': { main: 'idle' | 'busy'; side: number; queued: number };
  'reminder.due': { id: string; text: string; every: string | null; due: number; late: boolean };
  'message.system': { text: string; buttons?: ButtonRows; key?: string; ref?: string };
  'message.buttons_cleared': { key: string };
  'command.reply': { ref: string; text: string; buttons?: ButtonRows };
  // App-local events (published by core/connection.ts, never sent by the server):
  'app.connected': { first: boolean }; // the stream (re)opened: resync anything the stream may have missed
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

/** An app-local event (origin "system"), e.g. app.connected. */
export function localEvent<K extends EventType>(type: K, data: EventDataMap[K]): EdithEvent {
  return { type, ts: Date.now() / 1000, session_id: null, origin: 'system', data: data as unknown as Record<string, unknown> };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
