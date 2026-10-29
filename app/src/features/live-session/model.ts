// Live session: the transcript and turn state, reduced from stream events.

import type { Api, Reply, Status } from '../../core/api';
import type { ButtonRows, EdithEvent, EventBus, Lane, Origin } from '../../core/events';
import { bool, buttonRows, num, str } from '../../core/guards';
import { createStore, type Store } from '../../core/store';

export const MAX_ITEMS = 400; // the transcript keeps the newest ones; older ones drop off
const MAX_OPEN_CALLS = 32; // per tool name, waiting for their tool.result

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
  openCalls: Record<string, number[]>; // tool name -> ids of running calls, oldest first
  main: 'idle' | 'busy';
  side: number;
  queued: number;
  runs: Record<string, RunInfo>; // by turn ref
  session: { id: string; title: string | null } | null;
  seq: number;
}

export const initialLive: LiveState = { items: [], openCalls: {}, main: 'idle', side: 0, queued: 0, runs: {}, session: null, seq: 0 };

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

/** Fold one stream event into the state. Events this view doesn't show return `s` unchanged. */
export function reduce(s: LiveState, e: EdithEvent): LiveState {
  const d = e.data as Record<string, unknown>;
  const ts = e.ts;
  switch (e.type) {
    case 'message.user':
      return push(s, ts, { kind: 'user', text: str(d.text), origin: e.origin, voice: bool(d.voice) });
    case 'message.assistant':
      return push(s, ts, { kind: 'assistant', text: str(d.text) });
    case 'tool.call': {
      const name = str(d.name);
      const next = push(s, ts, { kind: 'tool', name, summary: str(d.summary), status: 'running', result: null });
      const open = [...(s.openCalls[name] ?? []), next.seq].slice(-MAX_OPEN_CALLS);
      return { ...next, openCalls: { ...s.openCalls, [name]: open } };
    }
    case 'tool.result': {
      // Results come back in call order, so the oldest open call of that tool is the one answered.
      const name = str(d.name);
      const [id, ...rest] = s.openCalls[name] ?? [];
      const status = bool(d.ok) ? 'ok' : 'error';
      const result = str(d.summary) || null;
      if (id === undefined || !s.items.some((x) => x.id === id)) {
        return push(s, ts, { kind: 'tool', name, summary: '', status, result });
      }
      const next = update(s, id, (x) => (x.kind === 'tool' ? { ...x, status, result } : x));
      return { ...next, openCalls: { ...s.openCalls, [name]: rest } };
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
      const next = { ...s, session: { id: str(d.session_id), title }, openCalls: {} };
      return push(next, ts, { kind: 'divider', text: title || 'New conversation' });
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
  send(text: string): Promise<void>;
  stop(): Promise<string>;
  press(itemId: number, action: string): Promise<string | null>;
  dispose(): void;
}

export function createLiveModel(bus: EventBus, api: Api): LiveModel {
  const store = createStore(initialLive);
  const myRefs = new Set<string>(); // presses whose later replies (command.reply) belong in this view

  const offs = [
    bus.subscribe('*', (e) => store.set((s) => reduce(s, e)), 'live-session'),
    bus.on(
      'app.connected',
      () => {
        api.status().then(
          (st) => store.set((s) => applyStatus(s, st)),
          () => {}, // the next reconnect tries again; the stream still updates the state
        );
      },
      'live-session',
    ),
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
    async send(text) {
      await api.send(text); // the message shows up when the transcript echoes it (message.user)
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
    dispose() {
      offs.forEach((off) => off());
    },
  };
}
