// EDITH's live status for the phone's Live Alerts (PLAN.md §4.11): the stream's turn, approval and
// voice events folded into one OngoingStatus view. Event-driven only: the elapsed time is a native
// chronometer, so nothing here ticks.

import type { Api } from '../../core/api';
import type { EdithEvent, EventBus } from '../../core/events';
import { num, str } from '../../core/guards';
import type { OngoingStatus, OngoingStatusView, Transport } from '../../core/ports';

export const MIN_UPDATE_MS = 1000; // Android rate-limits notification updates; one a second is plenty

interface Run {
  startedAt: number; // unix ms
  steps: number;
  step: string | null;
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

export function reduce(s: LiveStatusState, e: EdithEvent): LiveStatusState {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'turn.started':
      return { ...s, runs: { ...s.runs, [str(d.ref)]: { startedAt: e.ts * 1000, steps: 0, step: null } } };
    case 'turn.progress': {
      const ref = str(d.ref);
      const run = s.runs[ref] ?? { startedAt: (e.ts - num(d.elapsed)) * 1000, steps: 0, step: null };
      return { ...s, runs: { ...s.runs, [ref]: { ...run, steps: num(d.steps, run.steps), step: d.step ? str(d.step) : run.step } } };
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

/** What the notification says, most urgent first: an approval, then voice, then a running task. */
export function viewOf(s: LiveStatusState): OngoingStatusView | null {
  const approvals = Object.values(s.approvals);
  if (approvals.length) {
    const first = approvals[0]!;
    const more = approvals.length > 1 ? ` (+${approvals.length - 1} more)` : '';
    return {
      title: 'EDITH needs your approval',
      text: clip(`${first.tool}${first.detail ? `: ${first.detail}` : ''}`, 120) + more,
      chip: 'Approve?',
      startedAt: null,
      progress: false,
      link: 'edith://approvals',
      alert: true,
    };
  }
  if (s.voice === 'listening') return { title: 'EDITH is listening', text: 'Speak now', chip: 'Listening', startedAt: null, progress: false, link: 'edith://live', alert: false };
  if (s.voice === 'speaking') return { title: 'EDITH is speaking', text: 'Reading the answer aloud', chip: 'Speaking', startedAt: null, progress: false, link: 'edith://live', alert: false };
  const runs = Object.values(s.runs);
  if (!runs.length) return null;
  const startedAt = Math.min(...runs.map((r) => r.startedAt));
  const tasks = runs.length > 1 ? ` (${runs.length} tasks)` : '';
  const current = runs.reduce((a, b) => (b.startedAt < a.startedAt ? b : a));
  if (!runs.some((r) => r.steps > 0 || r.step)) {
    return { title: `EDITH is thinking${tasks}`, text: 'Working out what to do', chip: 'Thinking', startedAt, progress: true, link: 'edith://live', alert: false };
  }
  return {
    title: `EDITH is working${tasks}`,
    text: clip(current.step ?? 'Working', 120) + (current.steps ? ` · step ${current.steps}` : ''),
    chip: 'Working',
    startedAt,
    progress: true,
    link: 'edith://live',
    alert: false,
  };
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
    const wait = lastShownAt + MIN_UPDATE_MS - Date.now();
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
        Promise.all([api.status(), api.permissions()]).then(
          ([st, pending]) => {
            const now = Date.now();
            const runs: Record<string, Run> = {};
            for (const r of st.runs) runs[r.ref] = { startedAt: now - r.seconds * 1000, steps: state.runs[r.ref]?.steps ?? 0, step: r.step };
            const approvals: LiveStatusState['approvals'] = {};
            for (const p of pending) approvals[p.id] = { tool: p.tool, detail: p.detail };
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
