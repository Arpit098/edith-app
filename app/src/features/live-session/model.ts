// Live session: the transcript and turn state, reduced from stream events and filled from history.

import type { Api, HistoryPage, Reply, Status } from '../../core/api';
import { cursorOf, type ButtonRows, type EdithEvent, type EventBus, type Lane, type Origin } from '../../core/events';
import { bool, buttonRows, num, str } from '../../core/guards';
import { createStore, type Store } from '../../core/store';

export const MAX_ITEMS = 400; // the transcript keeps the newest ones; older ones drop off
export const PAGE = 100; // history events per request
const MAX_OPEN_CALLS = 200; // tool calls still waiting for their result
const MAX_CATCH_UP_PAGES = 10; // after that many `after=` pages, take the newest page instead
const MAX_BUFFER = 2000; // stream events held while a history request is out

export type Item =
  | { kind: 'user'; id: number; ts: number; text: string; origin: Origin; voice: boolean }
  | { kind: 'assistant'; id: number; ts: number; text: string }
  | { kind: 'tool'; id: number; ts: number; name: string; summary: string; status: 'running' | 'ok' | 'error'; result: string | null }
  | { kind: 'diff'; id: number; ts: number; path: string; diff: string }
  | { kind: 'system'; id: number; ts: number; text: string; tone: 'info' | 'error'; buttons: ButtonRows; key: string | null; note: string | null }
  | { kind: 'divider'; id: number; ts: number; text: string };

type NewItem = Item extends infer I ? (I extends Item ? Omit<I, 'id' | 'ts'> : never) : never;

export interface RunInfo {
  lane: Lane;
  step: string | null;
  steps: number;
  elapsed: number;
}

export interface LiveState {
  items: Item[]; // newest first (the list is drawn inverted)
  calls: Record<string, number>; // tool.call id -> its item id, until the result arrives
  cursor: string | null; // the newest transcript cursor applied: where a catch-up starts
  older: string | null; // cursor to load older history before, or null when there's no more
  loadingOlder: boolean;
  main: 'idle' | 'busy';
  side: number;
  queued: number;
  runs: Record<string, RunInfo>; // by turn ref
  session: { id: string; title: string | null } | null;
  seq: number;
}

export const initialLive: LiveState = {
  items: [],
  calls: {},
  cursor: null,
  older: null,
  loadingOlder: false,
  main: 'idle',
  side: 0,
  queued: 0,
  runs: {},
  session: null,
  seq: 0,
};

function push(s: LiveState, ts: number, item: NewItem): LiveState {
  const id = s.seq + 1;
  const items = [{ ...item, id, ts } as Item, ...s.items];
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
  return { ...s, items, seq: id };
}

function update(s: LiveState, id: number, change: (item: Item) => Item): LiveState {
  const i = s.items.findIndex((x) => x.id === id);
  if (i < 0) return s;
  const items = s.items.slice();
  items[i] = change(items[i]!);
  return { ...s, items };
}

function withoutRun(s: LiveState, ref: string): LiveState {
  if (!(ref in s.runs)) return s;
  const { [ref]: _gone, ...runs } = s.runs;
  return { ...s, runs };
}

const asLane = (v: unknown): Lane => (v === 'side' ? 'side' : 'main');

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
    case 'message.user':
      return push(s, ts, { kind: 'user', text: str(d.text), origin: e.origin, voice: bool(d.voice) });
    case 'message.assistant':
      return push(s, ts, { kind: 'assistant', text: str(d.text) });
    case 'tool.call': {
      const next = push(s, ts, { kind: 'tool', name: str(d.name), summary: str(d.summary), status: 'running', result: null });
      const id = str(d.id);
      if (!id) return next;
      const calls = { ...s.calls, [id]: next.seq };
      const keys = Object.keys(calls);
      if (keys.length > MAX_OPEN_CALLS) delete calls[keys[0]!]; // a call that never got its result
      return { ...next, calls };
    }
    case 'tool.result': {
      const id = str(d.id);
      const itemId = id ? s.calls[id] : undefined;
      const status = bool(d.ok) ? 'ok' : 'error';
      const result = str(d.summary) || null;
      if (itemId === undefined || !s.items.some((x) => x.id === itemId)) {
        return push(s, ts, { kind: 'tool', name: str(d.name), summary: '', status, result });
      }
      const { [id]: _done, ...calls } = s.calls;
      return { ...update(s, itemId, (x) => (x.kind === 'tool' ? { ...x, status, result } : x)), calls };
    }
    case 'file.diff':
      return push(s, ts, { kind: 'diff', path: str(d.path), diff: str(d.diff) });
    case 'turn.started':
    case 'turn.progress': {
      const ref = str(d.ref);
      const lane = asLane(d.lane);
      const run: RunInfo = { lane, step: d.step ? str(d.step) : (s.runs[ref]?.step ?? null), steps: num(d.steps), elapsed: num(d.elapsed) };
      return { ...s, runs: { ...s.runs, [ref]: run }, main: lane === 'main' ? 'busy' : s.main };
    }
    case 'turn.done': {
      const next = withoutRun(s, str(d.ref));
      return bool(d.is_error) ? push(next, ts, system(`⚠️ The turn ended with an error${d.subtype ? ` (${str(d.subtype)})` : ''}`, 'error')) : next;
    }
    case 'turn.stopped':
      return push(withoutRun(s, str(d.ref)), ts, system(d.lane === 'queued' ? '⏹ A queued message was dropped' : '⏹ Stopped'));
    case 'turn.failed': {
      const why = { not_ready: "Claude isn't ready", crashed: 'Claude crashed', queue_full: 'Too many messages waiting', bridge_error: 'Bridge error' }[str(d.reason)];
      const detail = str(d.detail);
      return push(withoutRun(s, str(d.ref)), ts, system(`❌ ${why ?? 'Failed'}${detail ? `: ${detail}` : ''}`, 'error'));
    }
    case 'turn.queued':
      return push(s, ts, system(`⏳ Queued (#${num(d.position, 1)})`));
    case 'lane.status':
      return { ...s, main: d.main === 'busy' ? 'busy' : 'idle', side: num(d.side), queued: num(d.queued) };
    case 'session.changed': {
      const title = d.title == null ? null : str(d.title);
      return push({ ...s, session: { id: str(d.session_id), title } }, ts, { kind: 'divider', text: title || 'New conversation' });
    }
    case 'message.system':
      return push(s, ts, system(str(d.text), 'info', { buttons: buttonRows(d.buttons), key: d.key ? str(d.key) : null }));
    case 'message.buttons_cleared': {
      const key = str(d.key);
      if (!s.items.some((x) => x.kind === 'system' && x.key === key && x.buttons.length)) return s;
      return { ...s, items: s.items.map((x) => (x.kind === 'system' && x.key === key ? { ...x, buttons: [] } : x)) };
    }
    default:
      return s;
  }
}

type SystemItem = Omit<Extract<Item, { kind: 'system' }>, 'id' | 'ts'>;

function system(text: string, tone: 'info' | 'error' = 'info', extra: Partial<SystemItem> = {}): SystemItem {
  return { kind: 'system', text, tone, buttons: [], key: null, note: null, ...extra };
}

/** The transcript rebuilt from a newest page (turn and lane state are kept). */
export function fromHistory(s: LiveState, page: HistoryPage): LiveState {
  const empty: LiveState = { ...s, items: [], calls: {}, cursor: page.cursor || null, older: page.more ? page.start : null };
  return page.events.reduce(reduce, empty);
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
  for (const r of st.runs) runs[r.ref] = { lane: r.lane, step: r.step, steps: s.runs[r.ref]?.steps ?? 0, elapsed: r.seconds };
  return { ...s, main: st.main, queued: st.queued, side: st.runs.filter((r) => r.lane === 'side').length, runs, session: st.session ?? s.session };
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
  /** Send a message; `voice` marks text that came from speech (EDITH answers with a spoken summary first). */
  send(text: string, opts?: { voice?: boolean }): Promise<void>;
  stop(): Promise<string>;
  press(itemId: number, action: string): Promise<string | null>;
  /** Load the page before the oldest shown (scrolling up). */
  loadOlder(): Promise<void>;
  dispose(): void;
}

export function createLiveModel(bus: EventBus, api: Api): LiveModel {
  const store = createStore(initialLive);
  const myRefs = new Set<string>(); // presses whose later replies (command.reply) belong in this view

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
        store.set((s) => reduce(s, e));
      },
      'live-session',
    ),
    bus.on(
      'app.connected',
      () => {
        void sync(store.get().cursor ? 'catch-up' : 'fresh');
        api.status().then(
          (st) => store.set((s) => applyStatus(s, st)),
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
      await api.send(text, opts.voice ? { voice: true } : {}); // the message shows up when the transcript echoes it (message.user)
    },
    async stop() {
      const r = await api.stop();
      const n = r.running + r.dropped.length;
      return n ? `Stopped ${n} task${n === 1 ? '' : 's'}` : 'Nothing was running';
    },
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
    },
  };
}
