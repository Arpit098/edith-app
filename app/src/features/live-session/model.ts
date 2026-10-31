// Live session: the transcript and turn state, reduced from stream events and filled from history.

import { backoffDelay, type Backoff } from '../../common/backoff';
import { ApiError, backgroundFrom, isRetryable, type Api, type BackgroundJob, type Command, type HistoryPage, type Reply, type Status, type StatusDetails } from '../../core/api';
import { cursorOf, type ButtonRows, type EdithEvent, type EventBus, type Lane, type Origin } from '../../core/events';
import { bool, buttonRows, num, str } from '../../core/guards';
import type { AppVisibility, KeyValueStore } from '../../core/ports';
import { createStore, type Store } from '../../core/store';
import { ID_LIFETIME_S, type SentAttachment } from './attachments';
import { quoteFrom, quoteText, type Quote } from './reply';
import { backgroundLine, trackTurnStart } from './status';

export const MAX_ITEMS = 400; // the transcript keeps the newest ones; older ones drop off
export const PAGE = 100; // history events per request
const MAX_OPEN_CALLS = 200; // tool calls still waiting for their result
const MAX_CATCH_UP_PAGES = 10; // after that many `after=` pages, take the newest page instead
const MAX_BUFFER = 2000; // stream events held while a history request is out

const MAX_TURNS = 200; // per-ref turn state kept for message statuses

/** How the server took a message (the coming `message.user.delivery`; derived from the POST until then). */
export type Delivery = 'main' | 'queued' | 'mid_turn' | 'side_lane' | 'command'; // command: a typed /command the bridge ran

/** A message sent from this app: kept until the server's record of it is matched by ref. */
export interface LocalSend {
  key: string; // local id, for retry
  status: 'sending' | 'waiting' | 'sent' | 'failed'; // waiting: offline, sent again on reconnect
  error: string | null;
  final?: boolean; // failed for good: sending again can't work (an attachment expired), so no retry
}

/** Why a message with attachments can't be sent any more: its ids are gone on the server. */
export const ATTACHMENT_EXPIRED = 'Attachment expired on edith. Re-attach it and send again.';
const EXPIRY_MARGIN_S = 600; // clock skew between the phone and edith

/** An attachment id of this message is past the server's lifetime (attachments.ts ID_LIFETIME_S). */
export function attachmentsExpired(attachments: SentAttachment[], ts: number, now: number): boolean {
  return attachments.some((a) => a.id !== '' && (a.uploaded ?? ts) + ID_LIFETIME_S - EXPIRY_MARGIN_S <= now);
}

/** The server's 400 for an id it doesn't know (expired, or evicted from its id list). */
const isUnknownAttachment = (e: unknown) => e instanceof ApiError && e.status === 400 && e.message.startsWith('unknown attachment');

export type Item =
  | {
      kind: 'user';
      id: number;
      ts: number;
      text: string;
      origin: Origin;
      voice: boolean;
      ref: string | null; // the turn it started (known once the POST answers, or from the event)
      delivery: Delivery | null;
      local: LocalSend | null; // set for messages this app sent
      echoed: boolean; // the server's message.user for it has arrived
      reaction: string | null; // EDITH's latest reaction (message.reaction)
      attachments: SentAttachment[];
      replyTo?: Quote | null; // the message this one replies to (swipe to reply; message.user.replying_to)
    }
  | { kind: 'assistant'; id: number; ts: number; text: string; lane: 'side' | null; ref: string | null }
  | { kind: 'tool'; id: number; ts: number; name: string; summary: string; status: 'running' | 'ok' | 'error'; result: string | null }
  | { kind: 'diff'; id: number; ts: number; path: string; diff: string }
  | { kind: 'system'; id: number; ts: number; text: string; tone: 'info' | 'error'; buttons: ButtonRows; key: string | null; note: string | null; ref?: string } // ref: the typed /command it answers
  | { kind: 'divider'; id: number; ts: number; text: string };

type NewItem = Item extends infer I ? (I extends Item ? Omit<I, 'id' | 'ts'> : never) : never;

export interface RunInfo {
  lane: Lane;
  step: string | null;
  steps: number;
  elapsed: number;
  active: boolean; // a tool is running (turn.progress / tool.call) until its result
}

/** What happened to a turn, by ref: the state a sent message shows. */
export interface TurnTrack {
  phase: 'queued' | 'running' | 'done' | 'failed' | 'stopped';
  lane: Lane | null;
  picked: boolean; // EDITH picked the message up (message.delivered, or the turn started)
}

export interface LiveState {
  items: Item[]; // newest first (the list is drawn inverted)
  approvals: Record<string, true>; // pending permission request ids
  turns: Record<string, TurnTrack>; // by ref, newest last, at most MAX_TURNS
  calls: Record<string, number>; // tool.call id -> its item id, until the result arrives
  cursor: string | null; // the newest transcript cursor applied: where a catch-up starts
  older: string | null; // cursor to load older history before, or null when there's no more
  loadingOlder: boolean;
  main: 'idle' | 'busy';
  side: number;
  queued: number;
  runs: Record<string, RunInfo>; // by turn ref
  // Work EDITH started in the background that still runs, maybe after her reply ended the turn:
  // not a turn (no timer, nothing for Stop to end), shown as "waiting" (status.ts).
  background: BackgroundJob[];
  // The server's clock minus the phone's (seconds), from the last answer or event that carried it:
  // background jobs are aged on the server's clock (their `started` is the server's), never the phone's.
  clockOffset: number;
  session: { id: string; title: string | null } | null;
  seq: number;
  // When the running turn began on the phone's clock, one value for the chip and the card alike
  // (status.ts trackTurnStart keeps it; the reducer never touches it). null while idle.
  turnStart: TurnStart | null;
}

export interface TurnStart {
  ref: string | null; // the main run it belongs to (null: busy with no run seen yet)
  elapsed: number | null; // the server's elapsed it was counted back from, if any
  at: number; // unix seconds, phone clock
}

export const initialLive: LiveState = {
  items: [],
  approvals: {},
  turns: {},
  calls: {},
  cursor: null,
  older: null,
  loadingOlder: false,
  main: 'idle',
  side: 0,
  queued: 0,
  runs: {},
  background: [],
  clockOffset: 0,
  session: null,
  seq: 0,
  turnStart: null,
};

function push(s: LiveState, ts: number, item: NewItem): LiveState {
  const id = s.seq + 1;
  return { ...s, items: trim([{ ...item, id, ts } as Item, ...s.items]), seq: id };
}

function update(s: LiveState, id: number, change: (item: Item) => Item): LiveState {
  const i = s.items.findIndex((x) => x.id === id);
  if (i < 0) return s;
  const items = s.items.slice();
  items[i] = change(items[i]!);
  return { ...s, items };
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return rest;
}

function withoutRun(s: LiveState, ref: string): LiveState {
  const runs = withoutKey(s.runs, ref);
  return runs === s.runs ? s : { ...s, runs };
}

/**
 * A turn ended: its run goes, and if it was the main lane's, the main lane is idle again (the next
 * queued message's turn.started makes it busy). The server sends no `lane.status`, so without this
 * `main` stayed "busy" until the next reconnect: the chip kept thinking, with its timer and Stop.
 */
function endRun(s: LiveState, ref: string, mainLane: boolean): LiveState {
  const wasMain = mainLane || s.runs[ref]?.lane === 'main';
  const next = withoutRun(s, ref);
  return wasMain && next.main !== 'idle' ? { ...next, main: 'idle' } : next;
}

/** Main-lane tool events (transcript: no ref) start or end "running <tool>" on the main run. */
function setMainTool(s: LiveState, active: boolean, step: string | null): LiveState {
  const ref = Object.keys(s.runs).find((r) => s.runs[r]!.lane === 'main');
  if (!ref) return s;
  const run = s.runs[ref]!;
  const next = { ...run, active, step: step ?? run.step };
  if (next.active === run.active && next.step === run.step) return s;
  return { ...s, runs: { ...s.runs, [ref]: next } };
}

const asLane = (v: unknown): Lane => (v === 'side' ? 'side' : 'main');

const AUDIO_EXT = /\.(ogg|mp3|m4a|wav|aac)$/i;

/** message.user.attachments (saved paths in edith's inbox) → what a bubble shows. */
function savedAttachments(v: unknown): SentAttachment[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .map((p) => {
      const name = p.split('/').pop() ?? p;
      return { id: '', name, kind: AUDIO_EXT.test(name) ? 'audio' : 'image', uri: null };
    });
}

/** The history's copy of a message sent from here keeps this phone's thumbnails (the server has only names). */
function withThumbs(server: SentAttachment[], mine: SentAttachment[]): SentAttachment[] {
  return mine.length ? mine : server;
}

/** The header the App API puts before app messages ("[App message from Arpit, <time>] [voice]\n"). */
const APP_HEADER = /^\[App message from [^\]\n]*\](?: \[voice\])?\s*\n/;

export function stripAppHeader(text: string): string {
  return text.replace(APP_HEADER, '');
}

const DELIVERIES = new Set<Delivery>(['main', 'queued', 'mid_turn', 'side_lane', 'command']);

/** The POST /v1/messages answer's lane → how the message was delivered. */
export function deliveryOf(lane: string): Delivery {
  return lane === 'side' ? 'side_lane' : lane === 'queued' ? 'queued' : lane === 'command' ? 'command' : 'main';
}

function track(s: LiveState, ref: string, change: Partial<TurnTrack>): LiveState {
  if (!ref) return s;
  const old = s.turns[ref];
  const t: TurnTrack = { phase: 'queued', lane: null, picked: false, ...old, ...change };
  t.picked ||= t.phase !== 'queued'; // running, done, failed or stopped: it was picked up
  if (old && old.phase === t.phase && old.lane === t.lane && old.picked === t.picked) return s; // progress events don't re-render rows
  const turns = { ...s.turns, [ref]: t };
  const keys = Object.keys(turns);
  if (keys.length > MAX_TURNS) delete turns[keys[0]!];
  return { ...s, turns };
}

function findUser(s: LiveState, match: (x: Extract<Item, { kind: 'user' }>) => boolean): number {
  return s.items.findIndex((x) => x.kind === 'user' && match(x));
}

/** The oldest match (items are newest first): echoes of the same text arrive in sending order. */
function findOldestUser(s: LiveState, match: (x: Extract<Item, { kind: 'user' }>) => boolean): number {
  for (let i = s.items.length - 1; i >= 0; i--) {
    const x = s.items[i]!;
    if (x.kind === 'user' && match(x)) return i;
  }
  return -1;
}

/** What a sent message shows, from its local state and its turn. */
export type SendStatus = 'sending' | 'sent' | 'queued' | 'running' | 'side' | 'folded' | 'answered' | 'failed' | 'stopped';

/** WhatsApp-style ticks on Arpit's bubbles: 🕓 not acknowledged yet, ✓ accepted, ✓✓ picked up, ! failed. */
export type Tick = 'clock' | 'sent' | 'delivered' | 'failed';

export function tickOf(item: Extract<Item, { kind: 'user' }>, turns: Record<string, TurnTrack>): Tick | null {
  if (!item.local) return item.origin === 'app' ? 'delivered' : null; // from history: it was picked up
  if (item.local.status === 'sending' || item.local.status === 'waiting') return 'clock';
  if (item.local.status === 'failed') return 'failed';
  const t = item.ref ? turns[item.ref] : undefined;
  if (t?.phase === 'failed') return 'failed';
  // message.user means accepted; ✓✓ only once Claude takes it in (message.delivered, or its turn starts).
  return t?.picked ? 'delivered' : 'sent';
}

/**
 * The "EDITH is working…" row, from the working-state mapping in contracts/events.md: waiting for
 * approval while one is pending; "Running <tool>" from turn.progress/tool.call until the tool's
 * result; "Thinking" otherwise while a turn runs; null when idle.
 */
export function workingLabel(s: LiveState): string | null {
  if (Object.keys(s.approvals).length) return 'Waiting for your approval';
  const runs = Object.values(s.runs);
  if (!runs.length) return null;
  const r = runs.find((x) => x.lane === 'main') ?? runs[0]!;
  return r.active && r.step ? `Running ${r.step}` : 'Thinking';
}

export function sendStatus(item: Extract<Item, { kind: 'user' }>, turns: Record<string, TurnTrack>): SendStatus | null {
  if (!item.local) return null; // not sent from this app
  if (item.local.status === 'sending' || item.local.status === 'waiting') return 'sending';
  if (item.local.status === 'failed') return 'failed';
  if (item.delivery === 'mid_turn') return 'folded'; // no turn of its own: it joined the running one
  if (item.delivery === 'command') return 'answered'; // the bridge ran it at once; its replies follow (/queue turns 'queued')
  const t = item.ref ? turns[item.ref] : undefined;
  const side = t?.lane === 'side' || item.delivery === 'side_lane';
  if (!t) return item.delivery === 'queued' ? 'queued' : side ? 'side' : 'sent';
  switch (t.phase) {
    case 'queued':
      return 'queued';
    case 'running':
      return side ? 'side' : 'running';
    case 'done':
      return 'answered';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'stopped';
  }
}

/** A message Arpit just sent: shown at once, before the server has it. */
export function addLocal(s: LiveState, key: string, text: string, voice: boolean, ts: number, attachments: SentAttachment[] = [], replyTo: Quote | null = null): LiveState {
  return push(s, ts, { kind: 'user', text, origin: 'app', voice, ref: null, delivery: null, local: { key, status: 'sending', error: null }, echoed: false, reaction: null, attachments, replyTo });
}

/** The POST answered: link the message to its turn. */
export function sentLocal(s: LiveState, key: string, ref: string, lane: string): LiveState {
  const i = findUser(s, (x) => x.local?.key === key);
  if (i < 0) return s;
  const item = s.items[i] as Extract<Item, { kind: 'user' }>;
  return update(s, item.id, () => ({ ...item, ref, delivery: item.delivery ?? deliveryOf(lane), local: { key, status: 'sent', error: null } }));
}

export function setLocal(s: LiveState, key: string, status: LocalSend['status'], error: string | null, final = false): LiveState {
  const i = findUser(s, (x) => x.local?.key === key);
  if (i < 0) return s;
  const item = s.items[i] as Extract<Item, { kind: 'user' }>;
  return update(s, item.id, () => ({ ...item, local: { key, status, error, ...(final ? { final } : {}) } }));
}

export function failedLocal(s: LiveState, key: string, error: string, final = false): LiveState {
  return setLocal(s, key, 'failed', error, final);
}

/** Items only this app knows (sent messages not yet echoed, side-lane answers): a history rebuild keeps them. */
function isLocalOnly(x: Item): boolean {
  return (x.kind === 'user' && !!x.local && !x.echoed) || (x.kind === 'assistant' && x.lane === 'side');
}

/** Fold one event into the state. Events this view doesn't show return `s` unchanged. */
export function reduce(s: LiveState, e: EdithEvent): LiveState {
  const next = apply(s, e);
  const cursor = cursorOf(e);
  return cursor && cursor !== next.cursor ? { ...next, cursor } : next;
}

function apply(s: LiveState, e: EdithEvent): LiveState {
  const d = e.data as Record<string, unknown>;
  const ts = e.ts;
  switch (e.type) {
    case 'message.user': {
      const text = stripAppHeader(str(d.text)).trim();
      const ref = d.ref ? str(d.ref) : null;
      const delivery = DELIVERIES.has(d.delivery as Delivery) ? (d.delivery as Delivery) : null;
      // The server's record of a message this app sent: one item, never two.
      let i = ref ? findUser(s, (x) => x.ref === ref) : -1;
      if (i < 0 && ref && e.origin === 'app') {
        // The server publishes this while still answering the POST, so it usually beats the POST's
        // answer: the message is still in flight with no ref. Adopt the ref on the oldest such message
        // with the same text (only in-flight ones: a waiting message hasn't reached the server).
        i = findOldestUser(s, (x) => !!x.local && !x.echoed && x.ref === null && x.local.status === 'sending' && x.text === text);
      }
      if (i < 0 && !ref && e.origin === 'app') {
        // An older server's transcript echo (no ref): only messages the server has acknowledged.
        i = findOldestUser(s, (x) => !!x.local && !x.echoed && x.local.status === 'sent' && x.text === text);
      }
      if (i >= 0) {
        const item = s.items[i] as Extract<Item, { kind: 'user' }>;
        return update(s, item.id, () => ({ ...item, echoed: true, ref: item.ref ?? ref, delivery: delivery ?? item.delivery, replyTo: item.replyTo ?? replyOf(s, d.replying_to) }));
      }
      return push(s, ts, { kind: 'user', text, origin: e.origin, voice: bool(d.voice), ref, delivery, local: null, echoed: true, reaction: null, attachments: savedAttachments(d.attachments), replyTo: replyOf(s, d.replying_to) });
    }
    case 'message.assistant': {
      const lane = d.lane === 'side' ? 'side' : null;
      const ref = d.ref ? str(d.ref) : null;
      const text = str(d.text);
      const shown = lane && ref ? s.items.find((x) => x.kind === 'assistant' && x.lane === 'side' && x.ref === ref) : undefined;
      if (shown) {
        // Already shown from turn.done: message.assistant is the clean text, so it wins.
        return shown.kind === 'assistant' && shown.text !== text && text ? update(s, shown.id, (x) => ({ ...x, text }) as Item) : s;
      }
      return push(s, ts, { kind: 'assistant', text, lane, ref });
    }
    case 'tool.call': {
      const next = push(s, ts, { kind: 'tool', name: str(d.name), summary: str(d.summary), status: 'running', result: null });
      const id = str(d.id);
      if (!id) return next;
      const calls = { ...s.calls, [id]: next.seq };
      const keys = Object.keys(calls);
      if (keys.length > MAX_OPEN_CALLS) delete calls[keys[0]!]; // a call that never got its result
      return setMainTool({ ...next, calls }, true, str(d.summary) || str(d.name));
    }
    case 'tool.result': {
      const id = str(d.id);
      const itemId = id ? s.calls[id] : undefined;
      const status = bool(d.ok) ? 'ok' : 'error';
      const result = str(d.summary) || null;
      const idle = setMainTool(s, false, null); // back to thinking after each result
      if (itemId === undefined || !idle.items.some((x) => x.id === itemId)) {
        return push(idle, ts, { kind: 'tool', name: str(d.name), summary: '', status, result });
      }
      const { [id]: _done, ...calls } = idle.calls;
      return { ...update(idle, itemId, (x) => (x.kind === 'tool' ? { ...x, status, result } : x)), calls };
    }
    case 'file.diff':
      return push(s, ts, { kind: 'diff', path: str(d.path), diff: str(d.diff) });
    case 'turn.started':
    case 'turn.progress': {
      const ref = str(d.ref);
      const lane = asLane(d.lane);
      const step = d.step ? str(d.step) : (s.runs[ref]?.step ?? null);
      const active = e.type === 'turn.progress' ? !!d.step || !!s.runs[ref]?.active : false;
      const run: RunInfo = { lane, step, steps: num(d.steps), elapsed: num(d.elapsed), active };
      return track({ ...s, runs: { ...s.runs, [ref]: run }, main: lane === 'main' ? 'busy' : s.main }, ref, { phase: 'running', lane });
    }
    case 'turn.done': {
      const ref = str(d.ref);
      const lane = d.lane === 'side' ? 'side' : 'main';
      let next = track(endRun(s, ref, lane === 'main'), ref, { phase: 'done', lane });
      // A side lane's reply isn't in the conversation's transcript: turn.done carries it, so show it
      // here (once: the server may also send it as message.assistant with lane "side").
      const text = str(d.display_text) || str(d.text); // display_text: without REACT:/SEND_FILE: lines
      if (lane === 'side' && text && !next.items.some((x) => x.kind === 'assistant' && x.lane === 'side' && x.ref === ref)) {
        next = push(next, ts, { kind: 'assistant', text, lane: 'side', ref });
      }
      return bool(d.is_error) ? push(next, ts, system(`⚠️ The turn ended with an error${d.subtype ? ` (${str(d.subtype)})` : ''}`, 'error')) : next;
    }
    case 'turn.stopped': {
      const ref = str(d.ref);
      // A dropped queued message (lane "queued") never ran: the lane it waited for is as it was.
      const next = track(endRun(s, ref, d.lane === 'main'), ref, { phase: 'stopped', lane: d.lane === 'side' ? 'side' : null });
      return push(next, ts, system(d.lane === 'queued' ? '⏹ A queued message was dropped' : '⏹ Stopped'));
    }
    case 'turn.failed': {
      const ref = str(d.ref);
      const why = { not_ready: "Claude isn't ready", crashed: 'Claude crashed', queue_full: 'Too many messages waiting', bridge_error: 'Bridge error' }[str(d.reason)];
      const detail = str(d.detail);
      // Only a turn that was running frees the lane (queue_full and not_ready never started one).
      const next = track(endRun(s, ref, false), ref, { phase: 'failed', lane: d.lane === 'side' ? 'side' : null });
      return push(next, ts, system(`❌ ${why ?? 'Failed'}${detail ? `: ${detail}` : ''}`, 'error'));
    }
    case 'turn.queued': {
      const ref = str(d.ref);
      const next = track(s, ref, { phase: 'queued', lane: null });
      // A message sent from here shows "queued" on its own bubble; others get a line.
      return findUser(next, (x) => x.ref === ref) >= 0 ? next : push(next, ts, system(`⏳ Queued (#${num(d.position, 1)})`));
    }
    case 'message.delivered': {
      // Claude took it in: as a new turn (main, side_lane) or folded into the running one (mid_turn).
      const ref = str(d.ref);
      const next = track(s, ref, { picked: true });
      const delivery = DELIVERIES.has(d.delivery as Delivery) ? (d.delivery as Delivery) : null;
      const i = ref && delivery ? findUser(next, (x) => x.ref === ref) : -1;
      if (i < 0) return next;
      const item = next.items[i] as Extract<Item, { kind: 'user' }>;
      return item.delivery === delivery ? next : update(next, item.id, () => ({ ...item, delivery }));
    }
    case 'message.reaction': {
      const ref = str(d.ref);
      const i = ref ? findUser(s, (x) => x.ref === ref) : -1;
      if (i < 0) return s;
      const item = s.items[i] as Extract<Item, { kind: 'user' }>;
      const reaction = str(d.emoji) || null;
      return item.reaction === reaction ? s : update(s, item.id, () => ({ ...item, reaction }));
    }
    case 'permission.request': {
      const id = str(d.id);
      return id && !s.approvals[id] ? { ...s, approvals: { ...s.approvals, [id]: true } } : s;
    }
    case 'permission.resolved': {
      const approvals = withoutKey(s.approvals, str(d.id));
      return approvals === s.approvals ? s : { ...s, approvals };
    }
    case 'background.changed':
      return { ...s, background: backgroundFrom(d.jobs) };
    case 'lane.status': {
      const next = { ...s, main: d.main === 'busy' ? ('busy' as const) : ('idle' as const), side: num(d.side), queued: num(d.queued) };
      // Nothing running anywhere: no turn can still be "working" (e.g. its end was missed while offline).
      return next.main === 'idle' && next.side === 0 ? { ...next, runs: {} } : next;
    }
    case 'session.changed': {
      const title = d.title == null ? null : str(d.title);
      return push({ ...s, session: { id: str(d.session_id), title } }, ts, { kind: 'divider', text: title || 'New conversation' });
    }
    case 'message.system':
      return push(s, ts, system(str(d.text), 'info', { buttons: buttonRows(d.buttons), key: d.key ? str(d.key) : null }));
    case 'command.reply': {
      // The answer to a /command typed in this chat (e.g. "✅ Compacted."), live or from history: a
      // system line under that message. Replies to other requests (a button, the commands screen)
      // have no message here; those requesters show them. Once per ref and text: a catch-up page can
      // hold the logged copy of a reply already shown live.
      const ref = str(d.ref);
      const text = str(d.text);
      if (!ref || findUser(s, (x) => x.ref === ref) < 0) return s;
      if (s.items.some((x) => x.kind === 'system' && x.ref === ref && x.text === text)) return s;
      return push(s, ts, system(text, 'info', { buttons: buttonRows(d.buttons), ref }));
    }
    case 'message.buttons_cleared': {
      const key = str(d.key);
      if (!s.items.some((x) => x.kind === 'system' && x.key === key && x.buttons.length)) return s;
      return { ...s, items: s.items.map((x) => (x.kind === 'system' && x.key === key ? { ...x, buttons: [] } : x)) };
    }
    default:
      return s;
  }
}

/** message.user.replying_to (the quoted text, or null) → the quote a bubble shows; who wrote it from the messages loaded. */
function replyOf(s: LiveState, v: unknown): Quote | null {
  // Normalised as ours are: a Telegram reply's quote keeps its newlines and runs to 1500 characters.
  const text = typeof v === 'string' ? quoteText(v.replace(/］/g, ']')) : '';
  return text ? { text, from: quoteFrom(s.items, text) } : null;
}

type SystemItem = Omit<Extract<Item, { kind: 'system' }>, 'id' | 'ts'>;

function system(text: string, tone: 'info' | 'error' = 'info', extra: Partial<SystemItem> = {}): SystemItem {
  return { kind: 'system', text, tone, buttons: [], key: null, note: null, ...extra };
}

/**
 * The transcript rebuilt from a newest page (turn and lane state are kept). Items only this app
 * knows (messages it sent that the history doesn't hold yet, side-lane answers) stay, in time order:
 * a refetch never makes a message disappear.
 */
export function fromHistory(s: LiveState, page: HistoryPage): LiveState {
  const empty: LiveState = { ...s, items: [], calls: {}, cursor: page.cursor || null, older: page.more ? page.start : null };
  let rebuilt = page.events.reduce(reduce, empty);
  const keep: Item[] = [];
  // Messages sent from here keep their local state (ticks, status) on the history's copy, by ref.
  for (const x of s.items) {
    if (x.kind !== 'user' || !x.local || !x.echoed || x.ref === null) continue;
    const copy = rebuilt.items.find((y) => y.kind === 'user' && y.ref === x.ref);
    if (copy) rebuilt = update(rebuilt, copy.id, (y) => (y.kind === 'user' ? { ...y, local: x.local, reaction: y.reaction ?? x.reaction, attachments: withThumbs(y.attachments, x.attachments), replyTo: y.replyTo ?? x.replyTo } : y));
  }
  for (const x of s.items.filter(isLocalOnly)) {
    if (x.kind === 'assistant') {
      if (!rebuilt.items.some((y) => y.kind === 'assistant' && y.ref !== null && y.ref === x.ref)) keep.push(x);
      continue;
    }
    if (x.kind !== 'user') continue;
    // Matched by ref only: the history's copy of this message takes over, keeping its local state
    // (ticks, status). A message without a ref (in flight, waiting, failed) is always kept.
    const copy = x.ref === null ? undefined : rebuilt.items.find((y) => y.kind === 'user' && y.ref === x.ref);
    if (copy) rebuilt = update(rebuilt, copy.id, (y) => (y.kind === 'user' ? { ...y, local: x.local, delivery: y.delivery ?? x.delivery, attachments: withThumbs(y.attachments, x.attachments), replyTo: y.replyTo ?? x.replyTo } : y));
    else keep.push(x);
  }
  if (!keep.length) return rebuilt;
  return { ...rebuilt, items: trim([...rebuilt.items, ...keep].sort((a, b) => b.ts - a.ts)) };
}

/** Messages this app sent that the server hasn't recorded yet: never trimmed away. */
function isPending(x: Item): boolean {
  return x.kind === 'user' && !!x.local && !x.echoed;
}

/** At most MAX_ITEMS (newest first): the oldest go, except pending messages. */
function trim(items: Item[]): Item[] {
  if (items.length <= MAX_ITEMS) return items;
  let excess = items.length - MAX_ITEMS;
  const out: Item[] = [];
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i]!;
    if (excess > 0 && !isPending(x)) excess--;
    else out.push(x);
  }
  return out.reverse();
}

/** Older events (a `before` page) added below the ones shown, as far as MAX_ITEMS allows. */
export function withOlder(s: LiveState, page: HistoryPage): LiveState {
  const room = MAX_ITEMS - s.items.length;
  if (room <= 0) return { ...s, older: null };
  const base: LiveState = { ...initialLive, seq: s.seq };
  const older = page.events.reduce(reduce, base);
  const items = older.items.slice(0, room);
  return {
    ...s,
    items: [...s.items, ...items],
    seq: older.seq,
    older: page.more && items.length === older.items.length ? page.start : null,
  };
}

/** Seed the turn state from GET /v1/status (after a (re)connect). */
export function applyStatus(s: LiveState, st: Status): LiveState {
  const runs: Record<string, RunInfo> = {};
  for (const r of st.runs) runs[r.ref] = { lane: r.lane, step: r.step, steps: s.runs[r.ref]?.steps ?? 0, elapsed: r.seconds, active: s.runs[r.ref]?.active ?? !!r.step };
  return { ...s, main: st.main, queued: st.queued, side: st.runs.filter((r) => r.lane === 'side').length, runs, background: st.background, session: st.session ?? s.session };
}

/** What the status bar shows. */
export interface TurnSummary {
  busy: boolean;
  step: string | null;
  elapsed: number;
  running: number;
  queued: number;
}

export function summarize(s: LiveState): TurnSummary {
  const runs = Object.values(s.runs);
  const main = runs.find((r) => r.lane === 'main') ?? runs[0];
  return { busy: s.main === 'busy' || runs.length > 0, step: main?.step ?? null, elapsed: main?.elapsed ?? 0, running: runs.length, queued: s.queued };
}

export interface LiveModel {
  store: Store<LiveState>;
  /**
   * Send a message; `voice` marks text that came from speech (EDITH answers with a spoken summary
   * first). It shows at once and keeps a state (sending, queued, side lane, answered, failed); it
   * never throws: a failed send stays in the list with Retry. `replyTo`: the message it replies to (swipe to reply).
   */
  send(text: string, opts?: { voice?: boolean; attachments?: SentAttachment[]; replyTo?: Quote | null }): Promise<void>;
  /** Send a failed message again. */
  retry(key: string): Promise<void>;
  /** Stop the running turns; the answer says what stopped, and what still runs in the background (a stop doesn't cancel it). */
  stop(): Promise<string>;
  /** The status panel's details (GET /v1/status/details); asked only while the panel is open. */
  details(): Promise<StatusDetails>;
  /**
   * The server commands the composer's menu offers (/compact, /status, …), asked once and kept;
   * a failure is asked again next time. Typed in this chat they run as commands (contracts/events.md).
   */
  commands(): Promise<Command[]>;
  /** Whether EDITH is on screen (the visibility port); undefined where there is none (always on screen). */
  visibility?: AppVisibility;
  press(itemId: number, action: string): Promise<string | null>;
  /** Load the page before the oldest shown (scrolling up). */
  loadOlder(): Promise<void>;
  dispose(): void;
}

// ---- the outbox: messages this app sent, kept across restarts until the server has them ----

// Commands the composer's menu leaves out: the app has its own controls for them (Stop, Sessions),
// or they're too drastic to be one tap away (/restart restarts EDITH).
export const CHAT_HIDDEN_COMMANDS = new Set(['start', 'help', 'sessions', 'resume', 'name', 'new', 'stop', 'restart']);

/** Whether a command needs arguments typed first: its usage names some ("<when> <what>"), not only optional ones ("[instructions]"). */
export function needsArgs(c: Pick<Command, 'usage'>): boolean {
  const usage = c.usage.trim();
  return usage !== '' && !usage.startsWith('[');
}

export const OUTBOX_KEY = 'edith.outbox';
const MAX_OUTBOX = 50;
export const RESEND_WITHIN_S = 3600; // older unsent messages wait for a tap instead of going by themselves
const OUTBOX_BACKOFF: Backoff = { baseMs: 2000, maxMs: 60_000 };

export interface OutboxEntry {
  key: string;
  text: string;
  voice: boolean;
  ts: number;
  status: LocalSend['status'];
  error: string | null;
  ref: string | null;
  delivery: Delivery | null;
  final?: boolean;
  attachments?: SentAttachment[]; // with their local uri (the thumbnail), which may be gone by the next start
  replyTo?: Quote | null;
}

/** The messages to keep: sent from here, not yet in the server's record (echo), newest last. */
export function outboxOf(s: LiveState): OutboxEntry[] {
  const out: OutboxEntry[] = [];
  for (const x of s.items) {
    if (x.kind !== 'user' || !x.local || x.echoed) continue;
    out.push({ key: x.local.key, text: x.text, voice: x.voice, ts: x.ts, status: x.local.status, error: x.local.error, ...(x.local.final ? { final: true } : {}), ref: x.ref, delivery: x.delivery, attachments: x.attachments, ...(x.replyTo ? { replyTo: x.replyTo } : {}) });
  }
  return out.reverse().slice(-MAX_OUTBOX);
}

/**
 * Put saved messages back after a restart (or an OTA reload). A message that was still in flight
 * when the app closed may have arrived, so it waits for a tap rather than going twice; a message
 * that was waiting for the network goes again by itself if it's under an hour old.
 */
export function restoreOutbox(s: LiveState, entries: OutboxEntry[], now: number): LiveState {
  let next = s;
  for (const e of entries) {
    if (findUser(next, (x) => x.local?.key === e.key) >= 0) continue;
    let status = e.status;
    let error = e.error;
    let final = e.final === true;
    const attachments = Array.isArray(e.attachments) ? e.attachments : [];
    if (status !== 'sent' && attachmentsExpired(attachments, e.ts, now)) {
      // Not "tap to retry": the server would answer "unknown attachment".
      status = 'failed';
      error = ATTACHMENT_EXPIRED;
      final = true;
    } else if (status === 'sending') {
      status = 'failed';
      error = 'The app closed while sending. Tap to send again if it didn\'t arrive.';
    } else if (status === 'waiting' && now - e.ts > RESEND_WITHIN_S) {
      status = 'failed';
      error = 'Not sent (no connection). Tap to send it now.';
    }
    next = push(next, e.ts, {
      kind: 'user',
      text: e.text,
      origin: 'app',
      voice: e.voice,
      ref: e.ref,
      delivery: e.delivery,
      local: { key: e.key, status, error, ...(final ? { final } : {}) },
      echoed: false,
      reaction: null,
      attachments, // a thumbnail whose file is gone falls back to the name chip (ItemView)
      replyTo: e.replyTo && typeof e.replyTo.text === 'string' ? e.replyTo : null,
    });
  }
  if (next === s) return s;
  return { ...next, items: [...next.items].sort((a, b) => b.ts - a.ts) };
}

/** A network failure that certainly didn't deliver the message: safe to send again by itself. */
function undelivered(e: unknown): boolean {
  return isRetryable(e) && !(e instanceof ApiError && e.message === 'timed out'); // a timeout may have arrived
}

export function createLiveModel(bus: EventBus, api: Api, storage?: KeyValueStore, visibility?: AppVisibility): LiveModel {
  const store = createStore(initialLive);
  trackTurnStart(store); // lives as long as the model; the store is the model's own
  const myRefs = new Set<string>(); // presses whose later replies (command.reply) belong in this view
  let localSeq = Date.now(); // keys stay unique across restarts
  let commandList: Promise<Command[]> | null = null;
  let flushing = false;
  let retryAttempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** POST a message already shown locally, then link it to its turn, or mark it waiting (offline) or failed. */
  async function post(key: string, text: string, voice: boolean, attachments: SentAttachment[] = [], replyTo: Quote | null = null): Promise<'sent' | 'waiting' | 'failed'> {
    const nowS = Date.now() / 1000;
    if (attachmentsExpired(attachments, nowS, nowS)) {
      store.set((s) => failedLocal(s, key, ATTACHMENT_EXPIRED, true));
      return 'failed';
    }
    try {
      const r = await api.send(text, {
        ...(voice ? { voice: true } : {}),
        ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}),
        ...(replyTo ? { replyingTo: replyTo } : {}),
      });
      store.set((s) => sentLocal(s, key, r.ref, r.lane));
      return 'sent';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (undelivered(e)) {
        store.set((s) => setLocal(s, key, 'waiting', message));
        scheduleFlush();
        return 'waiting';
      }
      if (isUnknownAttachment(e)) store.set((s) => failedLocal(s, key, ATTACHMENT_EXPIRED, true));
      else store.set((s) => failedLocal(s, key, message));
      return 'failed';
    }
  }

  const oldestWaiting = () => outboxOf(store.get()).find((e) => e.status === 'waiting');

  /**
   * Send waiting messages one at a time, oldest first. The next one is read afresh each time, so a
   * message queued meanwhile goes in order. One that fails for good (e.g. a 400) is marked failed
   * and the rest carry on; only "still offline" stops (post() reschedules).
   */
  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (let e = oldestWaiting(); e; e = oldestWaiting()) {
        const key = e.key;
        store.set((s) => setLocal(s, key, 'sending', null));
        if ((await post(key, e.text, e.voice, e.attachments, e.replyTo ?? null)) === 'waiting') return;
      }
      retryAttempt = 0;
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush() {
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void flush();
    }, backoffDelay(retryAttempt++, OUTBOX_BACKOFF));
  }

  // Persist the outbox whenever it changes (writes are rare: a send, an ack, an echo). Writes go in
  // order; `saved` moves only after a write succeeds, so a failed one is written again next time.
  let saved = '';
  let queued = '';
  let writing: Promise<unknown> = Promise.resolve();
  const offSave = storage
    ? store.subscribe(() => {
        const json = JSON.stringify(outboxOf(store.get()));
        if (json === queued) return;
        queued = json;
        writing = writing.then(async () => {
          try {
            await storage.set(OUTBOX_KEY, json);
            saved = json;
          } catch {
            if (queued === json) queued = saved; // the next change retries
          }
        });
      })
    : () => {};
  if (storage) {
    void storage.get(OUTBOX_KEY).then(
      (json) => {
        let entries: OutboxEntry[] = [];
        try {
          entries = json ? (JSON.parse(json) as OutboxEntry[]) : [];
        } catch {
          return; // unreadable: start clean
        }
        store.set((s) => restoreOutbox(s, Array.isArray(entries) ? entries : [], Date.now() / 1000));
        if (outboxOf(store.get()).some((e) => e.status === 'waiting')) void flush();
      },
      () => {},
    );
  }

  // History sync (contracts/events.md, "History"): while a page is being fetched, transcript events
  // from the stream wait here; afterwards only those the pages didn't already hold are applied.
  let syncing = false;
  let again: 'fresh' | 'catch-up' | null = null;
  let buffer: EdithEvent[] = [];

  async function sync(mode: 'fresh' | 'catch-up'): Promise<void> {
    if (syncing) {
      again = again === 'fresh' || mode === 'fresh' ? 'fresh' : 'catch-up';
      return;
    }
    syncing = true;
    const seen = new Set<string>();
    const take = (page: HistoryPage) => page.events.forEach((e) => seen.add(cursorOf(e) ?? ''));
    try {
      let after = mode === 'catch-up' ? store.get().cursor : null;
      let rebuild = after === null;
      // Catch up from the last cursor, page by page.
      for (let n = 0; after !== null; n++) {
        if (n === MAX_CATCH_UP_PAGES) {
          rebuild = true; // too far behind: the newest page is enough
          break;
        }
        const page = await api.history('current', { after, limit: PAGE });
        take(page);
        if (page.reset) {
          store.set((s) => fromHistory(s, page)); // another conversation by now: this is its newest page
          break;
        }
        store.set((s) => page.events.reduce(reduce, { ...s, cursor: page.cursor || s.cursor }));
        after = page.more ? page.cursor : null;
      }
      if (rebuild) {
        const page = await api.history('current', { limit: PAGE });
        take(page);
        store.set((s) => fromHistory(s, page));
      }
    } catch {
      // keep what we have; the next connect or session change tries again
    } finally {
      const waiting = buffer.filter((e) => !seen.has(cursorOf(e) ?? ''));
      buffer = [];
      syncing = false;
      if (waiting.length) store.set((s) => waiting.reduce(reduce, s));
      const next = again;
      again = null;
      if (next) void sync(next);
    }
  }

  const offs = [
    bus.subscribe(
      '*',
      (e) => {
        if (syncing && cursorOf(e)) {
          buffer.push(e);
          if (buffer.length > MAX_BUFFER) buffer.shift();
          return;
        }
        store.set((s) => {
          const next = reduce(s, e);
          // The stream's ts is the server's: background.changed sets the clock its jobs are aged on.
          return e.type === 'background.changed' ? { ...next, clockOffset: e.ts - Date.now() / 1000 } : next;
        });
      },
      'live-session',
    ),
    bus.on(
      'app.connected',
      () => {
        void sync(store.get().cursor ? 'catch-up' : 'fresh');
        retryAttempt = 0;
        void flush(); // messages that waited for the connection go now, in order
        api.status().then(
          (st) => store.set((s) => ({ ...applyStatus(s, st), clockOffset: st.ts != null ? st.ts - Date.now() / 1000 : s.clockOffset })),
          () => {}, // the next reconnect tries again; the stream still updates the state
        );
      },
      'live-session',
    ),
    // Another conversation: show its recent history instead of the old one's.
    bus.on('session.changed', () => void sync('fresh'), 'live-session'),
    bus.on(
      'command.reply',
      (e) => {
        const ref = str(e.data.ref);
        if (myRefs.has(ref)) addReplies(e.ts, [{ text: str(e.data.text), buttons: buttonRows(e.data.buttons) }]);
      },
      'live-session',
    ),
  ];

  function addReplies(ts: number, replies: Reply[]) {
    store.set((s) => replies.reduce((acc, r) => push(acc, ts, system(r.text, 'info', { buttons: r.buttons })), s));
  }

  return {
    store,
    async send(text, opts = {}) {
      const key = `local-${++localSeq}`;
      const attachments = opts.attachments ?? [];
      const replyTo = opts.replyTo ?? null;
      store.set((s) => addLocal(s, key, text, !!opts.voice, Date.now() / 1000, attachments, replyTo));
      if (flushing || oldestWaiting()) {
        // Older messages are still on their way: this one queues behind them, keeping the order.
        store.set((s) => setLocal(s, key, 'waiting', null));
        await flush();
        return;
      }
      await post(key, text, !!opts.voice, attachments, replyTo);
    },
    async retry(key) {
      const item = store.get().items.find((x) => x.kind === 'user' && x.local?.key === key);
      if (!item || item.kind !== 'user' || item.local?.status !== 'failed' || item.local.final) return;
      store.set((s) => update(s, item.id, (x) => (x.kind === 'user' ? { ...x, ref: null, delivery: null, local: { key, status: 'sending', error: null } } : x)));
      await post(key, item.text, item.voice, item.attachments, item.replyTo ?? null);
    },
    async stop() {
      const r = await api.stop();
      const now = r.ts ?? Date.now() / 1000 + store.get().clockOffset; // the server's clock
      store.set((s) => ({ ...s, background: r.background, clockOffset: r.ts != null ? r.ts - Date.now() / 1000 : s.clockOffset }));
      const n = r.running + r.dropped.length;
      const stopped = n ? `Stopped ${n} task${n === 1 ? '' : 's'}` : r.background.length ? 'No reply to stop' : 'Nothing was running';
      if (!r.background.length) return stopped;
      // Stop ends turns; work a turn left running in the background goes on (contracts/status.md).
      return `${stopped}. Still running in the background: ${r.background.map((j) => backgroundLine(j, now)).join('; ')}`;
    },
    details: () => api.statusDetails(),
    commands() {
      commandList ??= api.commands().then(
        (all) => all.filter((c) => !CHAT_HIDDEN_COMMANDS.has(c.name)),
        (e: unknown) => {
          commandList = null;
          throw e;
        },
      );
      return commandList;
    },
    visibility,
    async press(itemId, action) {
      const r = await api.press(action);
      if (r.ref) {
        myRefs.add(r.ref);
        if (myRefs.size > 50) myRefs.delete(myRefs.values().next().value!);
      }
      store.set((s) => update(s, itemId, (x) => (x.kind === 'system' ? { ...x, buttons: [], note: r.note ?? x.note } : x)));
      addReplies(Date.now() / 1000, r.replies);
      return r.toast;
    },
    async loadOlder() {
      const s = store.get();
      if (!s.older || s.loadingOlder || syncing) return;
      const before = s.older;
      store.set((x) => ({ ...x, loadingOlder: true }));
      try {
        const page = await api.history('current', { before, limit: PAGE });
        // Ignore it if the transcript was replaced meanwhile (or the conversation changed).
        store.set((x) => (page.reset || x.older !== before ? x : withOlder(x, page)));
      } catch {
        // scrolling up again retries
      } finally {
        store.set((x) => ({ ...x, loadingOlder: false }));
      }
    },
    dispose() {
      offs.forEach((off) => off());
      offSave();
      if (retryTimer) clearTimeout(retryTimer);
    },
  };
}
