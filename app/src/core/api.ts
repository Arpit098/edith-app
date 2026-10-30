// Typed App API client over the Transport port. Mirrors contracts/events.md, "App API (v1)".

import { toEvent, type ButtonRows, type EdithEvent, type Lane } from './events';
import { bool, buttonRows, num, str } from './guards';
import type { RequestOptions, Transport } from './ports';

/** A failed request. `status` is the HTTP status, or 0 when the server wasn't reached (or timed out). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Failures worth retrying: the server wasn't reached (0) or a gateway/overload answer. */
export const RETRY_STATUS: ReadonlySet<number> = new Set([0, 502, 503, 504]);

export function isRetryable(e: unknown): boolean {
  return e instanceof ApiError && RETRY_STATUS.has(e.status);
}

export interface Reply {
  text: string;
  buttons: ButtonRows;
}

export interface Session {
  session_id: string;
  title: string | null;
  updated: number; // unix seconds
  current: boolean;
}

export interface Run {
  ref: string;
  lane: Lane;
  seconds: number;
  step: string | null;
}

export interface Status {
  main: 'busy' | 'idle';
  queued: number;
  runs: Run[];
  tmux: 'running' | 'down';
  conversation: boolean;
  session: { id: string; title: string | null } | null;
}

/** GET /v1/status/details (contracts/status.md): the status panel. Times are unix seconds. */
export interface StatusDetails {
  ts: number; // the server's clock when it answered
  edith: {
    state: 'idle' | 'thinking' | 'tool' | 'waiting_approval';
    tool: string | null;
    step: string | null;
    since: number | null;
    ref: string | null;
    turn_started: number | null;
    tmux: 'running' | 'down';
  };
  lanes: { side: { ref: string; seconds: number; step: string | null; summary: string | null }[]; max_side: number; queued: number; approvals: number };
  session: { id: string; title: string | null; started: number | null; messages: number | null; context_tokens: number | null } | null;
  agents: { name: string; dir: string; branch: string | null; state: 'busy' | 'idle' | 'blocked'; blocked: 'permission' | 'usage_limit' | null; last: string | null }[];
  server: { tag: string | null; started: number; uptime: number };
}

export interface PendingPermission {
  id: string;
  tool: string;
  detail: string;
  ref: string | null;
  lane: Lane | null;
}

export interface HistoryPage {
  session_id: string;
  events: EdithEvent[]; // oldest first; live-view events, each with data.cursor
  start: string; // cursor of the page's first entry: ask `before` it for older events
  cursor: string; // cursor after the page's last entry: ask `after` it for newer ones
  more: boolean;
  reset: boolean; // the cursor given was another conversation's: this is the newest page instead
}

/** GET /v1/app/latest (contracts/app-updates.md §3). */
export interface AppRelease {
  versionName: string;
  versionCode: number;
  sha: string;
  built_at: number; // unix seconds
  runtimeVersion: string;
  size: number;
  sha256: string; // hex
  cert_sha256: string;
  notes: string;
  url: string; // path on the App API, e.g. /v1/app/apk/1042
}

/** POST /v1/attachments (contracts/attachments.md). */
export interface Attachment {
  id: string;
  name: string; // saved name in edith's inbox
  type: string; // detected by the server from the bytes
  size: number;
  sha256: string;
}

export interface Command {
  name: string;
  description: string;
  usage: string;
  help: string;
}

export interface ActionResult {
  ref: string;
  toast: string | null;
  note: string | null;
  replies: Reply[];
}

const seg = encodeURIComponent;

function replies(v: unknown): Reply[] {
  return Array.isArray(v) ? v.map((r: Record<string, unknown>) => ({ text: str(r?.text), buttons: buttonRows(r?.buttons) })) : [];
}

function strOrNull(v: unknown): string | null {
  return v == null ? null : str(v);
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

function list(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter((x): x is Obj => !!x && typeof x === 'object') : [];
}

export function statusDetailsFrom(r: Obj): StatusDetails {
  const e = (r.edith ?? {}) as Obj;
  const lanes = (r.lanes ?? {}) as Obj;
  const session = r.session as Obj | null | undefined;
  const server = (r.server ?? {}) as Obj;
  return {
    ts: num(r.ts, Date.now() / 1000),
    edith: {
      state: oneOf(e.state, ['idle', 'thinking', 'tool', 'waiting_approval'] as const, 'idle'),
      tool: strOrNull(e.tool),
      step: strOrNull(e.step),
      since: numOrNull(e.since),
      ref: strOrNull(e.ref),
      turn_started: numOrNull(e.turn_started),
      tmux: e.tmux === 'running' ? 'running' : 'down',
    },
    lanes: {
      side: list(lanes.side).map((x) => ({ ref: str(x.ref), seconds: num(x.seconds), step: strOrNull(x.step), summary: strOrNull(x.summary) })),
      max_side: num(lanes.max_side),
      queued: num(lanes.queued),
      approvals: num(lanes.approvals),
    },
    session: session
      ? { id: str(session.id), title: strOrNull(session.title), started: numOrNull(session.started), messages: numOrNull(session.messages), context_tokens: numOrNull(session.context_tokens) }
      : null,
    agents: list(r.agents).map((a) => ({
      name: str(a.name),
      dir: str(a.dir),
      branch: strOrNull(a.branch),
      state: oneOf(a.state, ['busy', 'idle', 'blocked'] as const, 'idle'),
      blocked: a.blocked === 'permission' || a.blocked === 'usage_limit' ? a.blocked : null,
      last: strOrNull(a.last),
    })),
    server: { tag: strOrNull(server.tag), started: num(server.started), uptime: num(server.uptime) },
  };
}

function lane(v: unknown): Lane | null {
  return v === 'main' || v === 'side' ? v : null;
}

export function permissionFrom(p: Record<string, unknown>): PendingPermission {
  return { id: str(p.id), tool: str(p.tool), detail: str(p.detail), ref: p.ref == null ? null : str(p.ref), lane: lane(p.lane) };
}

type Obj = Record<string, unknown>;

export function createApi(t: Transport) {
  return {
    /** Send text to the main lane (or a side lane when busy). The turn's events arrive with `ref`. */
    async send(text: string, opts: { voice?: boolean; queue?: boolean; attachments?: string[] } = {}): Promise<{ ref: string; lane: string }> {
      const { attachments, ...rest } = opts;
      const r = await t.request<Obj>('POST', '/v1/messages', { text, ...rest, ...(attachments?.length ? { attachments } : {}) });
      return { ref: str(r.ref), lane: str(r.lane) };
    },

    /**
     * Upload one file for a message (contracts/attachments.md): the raw bytes, streamed. The id goes
     * in send({attachments}); it stays valid for 7 days. 404 means edith doesn't have this route yet.
     */
    async uploadAttachment(
      file: { uri: string; mime: string; name: string; size: number },
      opts: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal } = {},
    ): Promise<Attachment> {
      // 30 s plus 1 s per 100 KB: generous for Tailscale on mobile data, bounded at 10 minutes.
      // The caller stats the file first (attachments.ts): a size is required, so this is never "30 s for anything".
      if (!(file.size > 0)) throw new ApiError(0, 'unknown file size');
      const timeoutMs = Math.min(600_000, 30_000 + Math.ceil(file.size / 100_000) * 1000);
      const r = await t.uploadRaw<Obj>('/v1/attachments', file, { timeoutMs, ...opts });
      return { id: str(r.id), name: str(r.name), type: str(r.type), size: num(r.size), sha256: str(r.sha256) };
    },

    async stop(): Promise<{ running: number; dropped: string[] }> {
      const r = await t.request<Obj>('POST', '/v1/stop');
      return { running: num(r.running), dropped: Array.isArray(r.dropped) ? r.dropped.map((d) => str(d)) : [] };
    },

    async status(opts?: RequestOptions): Promise<Status> {
      const r = await t.request<Obj>('GET', '/v1/status', undefined, opts);
      const session = r.session as Obj | null | undefined;
      return {
        main: r.main === 'busy' ? 'busy' : 'idle',
        queued: num(r.queued),
        runs: (Array.isArray(r.runs) ? r.runs : []).map((x: Obj) => ({
          ref: str(x.ref),
          lane: lane(x.lane) ?? 'main',
          seconds: num(x.seconds),
          step: x.step == null ? null : str(x.step),
        })),
        tmux: r.tmux === 'running' ? 'running' : 'down',
        conversation: bool(r.conversation),
        session: session ? { id: str(session.id), title: session.title == null ? null : str(session.title) } : null,
      };
    },

    async statusDetails(opts?: RequestOptions): Promise<StatusDetails> {
      return statusDetailsFrom(await t.request<Obj>('GET', '/v1/status/details', undefined, opts));
    },

    async sessions(): Promise<Session[]> {
      const r = await t.request<Obj>('GET', '/v1/sessions');
      return (Array.isArray(r.sessions) ? r.sessions : []).map((s: Obj) => ({
        session_id: str(s.session_id),
        title: s.title == null ? null : str(s.title),
        updated: num(s.updated),
        current: bool(s.current),
      }));
    },

    /** Starts a switch; the outcome arrives as command.reply with this `ref` (plus session.changed). */
    async resume(sessionId: string): Promise<{ ref: string }> {
      const r = await t.request<Obj>('POST', `/v1/sessions/${seg(sessionId)}/resume`);
      return { ref: str(r.ref) };
    },

    /**
     * A page of the conversation's live-view events, oldest first (contracts/events.md, "History").
     * No cursor: the newest page. `after`: what followed it. `before`: what came before it.
     */
    async history(sessionId: string, q: { after?: string; before?: string; limit?: number } = {}): Promise<HistoryPage> {
      const query = Object.entries(q)
        .filter(([, v]) => v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
      const r = await t.request<Obj>('GET', `/v1/sessions/${seg(sessionId)}/history${query ? `?${query}` : ''}`);
      return {
        session_id: str(r.session_id),
        events: (Array.isArray(r.events) ? r.events : []).map(toEvent).filter((e): e is EdithEvent => e !== null),
        start: str(r.start),
        cursor: str(r.cursor),
        more: bool(r.more),
        reset: bool(r.reset),
      };
    },

    async newSession(): Promise<'ok' | 'busy'> {
      const r = await t.request<Obj>('POST', '/v1/sessions/new');
      return r.result === 'busy' ? 'busy' : 'ok';
    },

    async rename(sessionId: string, title: string): Promise<{ session_id: string; title: string }> {
      const r = await t.request<Obj>('PATCH', `/v1/sessions/${seg(sessionId)}`, { title });
      return { session_id: str(r.session_id), title: str(r.title) };
    },

    async permissions(): Promise<PendingPermission[]> {
      const r = await t.request<Obj>('GET', '/v1/permissions');
      return (Array.isArray(r.pending) ? r.pending : []).map(permissionFrom);
    },

    /** Allow or deny. Throws ApiError 404 when the request has already expired. */
    async answer(id: string, allow: boolean): Promise<{ id: string; decision: string }> {
      const r = await t.request<Obj>('POST', `/v1/permissions/${seg(id)}`, { allow });
      return { id: str(r.id), decision: str(r.decision) };
    },

    /** Press a reply button. */
    async press(action: string): Promise<ActionResult> {
      const r = await t.request<Obj>('POST', '/v1/actions', { action });
      return { ref: str(r.ref), toast: r.toast ? str(r.toast) : null, note: r.note ? str(r.note) : null, replies: replies(r.replies) };
    },

    /** The newest APK edith offers, or null when it has none yet (404). */
    async appLatest(): Promise<AppRelease | null> {
      let r: Obj;
      try {
        r = await t.request<Obj>('GET', '/v1/app/latest');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
      const sha256 = str(r.sha256).toLowerCase();
      const url = str(r.url);
      // Only a well-formed answer is usable: the download is checked against this sha256.
      if (!/^[0-9a-f]{64}$/.test(sha256) || !url.startsWith('/v1/app/apk/')) throw new ApiError(502, 'edith sent a malformed app release');
      return {
        versionName: str(r.versionName),
        versionCode: num(r.versionCode),
        sha: str(r.sha),
        built_at: num(r.built_at),
        runtimeVersion: str(r.runtimeVersion),
        size: num(r.size),
        sha256,
        cert_sha256: str(r.cert_sha256),
        notes: str(r.notes),
        url,
      };
    },

    async commands(): Promise<Command[]> {
      const r = await t.request<Obj>('GET', '/v1/commands');
      return (Array.isArray(r.commands) ? r.commands : []).map((c: Obj) => ({
        name: str(c.name),
        description: str(c.description),
        usage: str(c.usage),
        help: str(c.help),
      }));
    },

    /** Run a command; later replies arrive as command.reply with the returned `ref`. */
    async run(name: string, args = ''): Promise<{ ref: string; replies: Reply[] }> {
      const r = await t.request<Obj>('POST', `/v1/commands/${seg(name)}`, args ? { args } : {});
      return { ref: str(r.ref), replies: replies(r.replies) };
    },
  };
}

export type Api = ReturnType<typeof createApi>;
