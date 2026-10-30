// EDITH's live status for the phone's Live Alerts (PLAN.md §4.11): the stream's turn, tool, approval
// and voice events folded into one OngoingStatus view. Event-driven only: the elapsed time is a native
// chronometer (re-anchored on each turn.progress), so nothing here ticks.

import type { Api } from '../../core/api';
import type { EdithEvent, EventBus } from '../../core/events';
import { num, str } from '../../core/guards';
import type { OngoingStatus, OngoingStatusView, Transport } from '../../core/ports';

export const MIN_UPDATE_MS = 1000; // Android rate-limits notification updates; one a second is plenty

interface Run {
  startedAt: number; // unix ms, phone clock (server and phone clocks may differ)
  lane: 'main' | 'side';
  steps: number;
  step: string | null; // the latest tool summary, e.g. "$ npm test"
  tool: string | null; // the tool running now (main lane: tool.call until its tool.result)
}

export interface LiveStatusState {
  runs: Record<string, Run>; // by turn ref
  approvals: Record<string, { tool: string; detail: string }>; // by request id, in arrival order
  voice: 'listening' | 'speaking' | 'idle';
}

export const initialStatus: LiveStatusState = { runs: {}, approvals: {}, voice: 'idle' };

function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const { [key]: _gone, ...rest } = map;
  return rest;
}

/** The main lane's run: tool.call/tool.result come from its transcript and carry no ref. */
function mainRef(s: LiveStatusState): string | null {
  for (const [ref, r] of Object.entries(s.runs)) if (r.lane === 'main') return ref;
  return null;
}

/** `now` is when the event arrived (unix ms), so the timer runs on the phone's clock. */
export function reduce(s: LiveStatusState, e: EdithEvent, now: number = Date.now()): LiveStatusState {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'turn.started': {
      const ref = str(d.ref);
      if (!ref) return s;
      const lane = d.lane === 'side' ? 'side' : 'main';
      return { ...s, runs: { ...s.runs, [ref]: { startedAt: now, lane, steps: 0, step: null, tool: null } } };
    }
    case 'turn.progress': {
      const ref = str(d.ref);
      if (!ref) return s;
      const run = s.runs[ref] ?? { startedAt: now, lane: d.lane === 'side' ? 'side' : 'main', steps: 0, step: null, tool: null };
      // The server's elapsed is the truth: re-anchor the timer on it.
      const startedAt = d.elapsed == null ? run.startedAt : now - num(d.elapsed) * 1000;
      return { ...s, runs: { ...s.runs, [ref]: { ...run, startedAt, steps: num(d.steps, run.steps), step: d.step ? str(d.step) : run.step } } };
    }
    case 'tool.call':
    case 'tool.result': {
      const ref = mainRef(s);
      if (!ref) return s;
      const run = s.runs[ref]!;
      const next = e.type === 'tool.call' ? { ...run, tool: str(d.name) || run.tool, step: d.summary ? str(d.summary) : run.step } : { ...run, tool: null };
      return { ...s, runs: { ...s.runs, [ref]: next } };
    }
    case 'turn.done':
    case 'turn.failed':
    case 'turn.stopped':
      return { ...s, runs: without(s.runs, str(d.ref)) };
    case 'lane.status':
      // Nothing running anywhere: drop any run whose end we missed (e.g. while reconnecting).
      return d.main === 'idle' && num(d.side) === 0 && Object.keys(s.runs).length ? { ...s, runs: {} } : s;
    case 'permission.request': {
      const id = str(d.id);
      return id && !(id in s.approvals) ? { ...s, approvals: { ...s.approvals, [id]: { tool: str(d.tool), detail: str(d.detail) } } } : s;
    }
    case 'permission.resolved':
      return { ...s, approvals: without(s.approvals, str(d.id)) };
    case 'app.voice': {
      const v = d.state === 'listening' || d.state === 'speaking' ? d.state : 'idle';
      return v === s.voice ? s : { ...s, voice: v };
    }
    default:
      return s;
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * What the notification says, most urgent first: an approval, then voice, then the oldest running
 * turn (running <tool>, or thinking). The pill (chip) carries the state; the card adds the detail and
 * the elapsed time. Taps open the live chat, or the approvals while one waits.
 */
export function viewOf(s: LiveStatusState): OngoingStatusView | null {
  const runs = Object.values(s.runs);
  const approvals = Object.values(s.approvals);
  const keepAlive = runs.length > 0 || approvals.length > 0;
  const startedAt = runs.length ? Math.min(...runs.map((r) => r.startedAt)) : null;
  if (approvals.length) {
    const first = approvals[0]!;
    const more = approvals.length > 1 ? ` (+${approvals.length - 1} more)` : '';
    return {
      title: 'Waiting for your approval',
      text: clip(`${first.tool}${first.detail ? `: ${first.detail}` : ''}`, 120) + more,
      chip: 'Approve?',
      startedAt,
      progress: false,
      link: 'edith://approvals',
      alert: true,
      keepAlive,
    };
  }
  const plain = { startedAt, link: 'edith://live', alert: false, keepAlive };
  if (s.voice === 'listening') return { ...plain, title: 'EDITH is listening', text: 'Speak now', chip: 'Listening', progress: false };
  if (s.voice === 'speaking') return { ...plain, title: 'EDITH is speaking', text: 'Reading the answer aloud', chip: 'Speaking', progress: false };
  if (!runs.length) return null;
  const tasks = runs.length > 1 ? ` · ${runs.length} tasks` : '';
  const current = runs.reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
  const steps = current.steps ? ` · step ${current.steps}` : '';
  if (current.tool) {
    return { ...plain, title: `Running ${current.tool}${tasks}`, text: clip(current.step ?? current.tool, 120) + steps, chip: clip(current.tool, 12), progress: true };
  }
  if (current.lane === 'side' && current.step) {
    // Side lanes report only turn.progress: the step is the tool that ran last.
    return { ...plain, title: `Running a parallel task${tasks}`, text: clip(current.step, 120) + steps, chip: 'Working', progress: true };
  }
  return { ...plain, title: `EDITH is thinking${tasks}`, text: current.step ? `Last: ${clip(current.step, 110)}${steps}` : 'Working out what to do', chip: 'Thinking', progress: true };
}

function sameView(a: OngoingStatusView | null, b: OngoingStatusView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (Object.keys(a) as (keyof OngoingStatusView)[]).every((k) => a[k] === b[k]);
}

export interface LiveStatusModel {
  state(): LiveStatusState;
  dispose(): void;
}

export function createLiveStatus(deps: { bus: EventBus; api: Api; status: OngoingStatus; transport: Transport }): LiveStatusModel {
  const { bus, api, status, transport } = deps;
  let state = initialStatus;
  let shown: OngoingStatusView | null = null;
  let lastShownAt = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let release: (() => void) | null = null;
  let askedPermission = false;
  let sync = 0; // a newer resync wins over an older one still in flight

  function render() {
    const view = viewOf(state);
    if (!view) {
      if (pending) clearTimeout(pending);
      pending = null;
      if (shown) status.clear();
      shown = null;
      release?.(); // idle: the stream may sleep in the background again
      release = null;
      return;
    }
    release ??= transport.holdOpen(); // keep events coming while the status is up
    if (!askedPermission) {
      askedPermission = true;
      void status.ensurePermission().catch(() => false);
    }
    if (sameView(view, shown) || pending) return;
    // Starting or stopping the foreground service is never held back: only plain updates are throttled.
    const wait = shown && shown.keepAlive === view.keepAlive ? lastShownAt + MIN_UPDATE_MS - Date.now() : 0;
    if (wait > 0) {
      pending = setTimeout(() => {
        pending = null;
        flush();
      }, wait);
      return;
    }
    flush();
  }

  function flush() {
    const view = viewOf(state); // the newest, not the one that scheduled this
    if (!view || sameView(view, shown)) return;
    status.show(view);
    shown = view;
    lastShownAt = Date.now();
  }

  function apply(next: LiveStatusState) {
    if (next === state) return;
    state = next;
    render();
  }

  const offs = [
    bus.subscribe('*', (e) => apply(reduce(state, e)), 'live-status'),
    bus.on(
      'app.connected',
      () => {
        // Events sent while disconnected are gone: take the server's view of runs and approvals.
        const mine = ++sync;
        Promise.all([api.status(), api.permissions()]).then(
          ([st, waiting]) => {
            if (mine !== sync) return;
            const now = Date.now();
            const runs: Record<string, Run> = {};
            for (const r of st.runs) {
              const had = state.runs[r.ref];
              runs[r.ref] = { startedAt: now - r.seconds * 1000, lane: r.lane, steps: had?.steps ?? 0, step: r.step, tool: had?.tool ?? null };
            }
            const approvals: LiveStatusState['approvals'] = {};
            for (const p of waiting) approvals[p.id] = { tool: p.tool, detail: p.detail };
            apply({ ...state, runs, approvals });
          },
          () => {}, // keep what we have; the next connect tries again
        );
      },
      'live-status',
    ),
  ];

  return {
    state: () => state,
    dispose() {
      offs.forEach((off) => off());
      if (pending) clearTimeout(pending);
      if (shown) status.clear();
      release?.();
    },
  };
}
