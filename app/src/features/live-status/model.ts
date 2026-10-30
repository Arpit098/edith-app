// EDITH's live status for the phone's Live Alerts (PLAN.md §4.11): the stream's turn, tool, approval
// and voice events folded into one OngoingStatus view. Event-driven only: the elapsed time is a native
// chronometer (re-anchored on each turn.progress), so nothing here ticks.

import type { Api } from '../../core/api';
import type { EdithEvent, EventBus } from '../../core/events';
import { num, str } from '../../core/guards';
import type { OngoingStatus, OngoingStatusView, Transport } from '../../core/ports';

export const MIN_UPDATE_MS = 1000; // Android rate-limits notification updates; one a second is plenty
export const REANCHOR_MS = 1000; // move the timer only when the server's elapsed differs by this much
export const IDLE_MS = 10 * 60 * 1000; // no event for this long while holding: ask the server if it's still busy
export const MAX_HOLD_MS = 3 * 60 * 60 * 1000; // never keep EDITH alive longer than this in one go
const CHECK_TIMEOUT_MS = 8000;
const BUFFER_MAX = 500; // events kept while a resync is in flight, to replay over its snapshot

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
      // The server's elapsed is the truth: re-anchor the timer on it, but only when it is off by a
      // second or more (each update re-posts the notification).
      const anchored = d.elapsed == null ? run.startedAt : now - num(d.elapsed) * 1000;
      const startedAt = Math.abs(anchored - run.startedAt) >= REANCHOR_MS ? anchored : run.startedAt;
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
 * the elapsed time. Taps open the live chat, or the approvals while one waits. The status itself
 * never makes a sound: an approval alerts once, through its own notification (features/notifications).
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
      keepAlive,
    };
  }
  const plain = { startedAt, link: 'edith://live', keepAlive };
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
  let buffered: EdithEvent[] | null = null; // events that arrived while a resync was in flight
  // Keep-alive guards: EDITH must never be held forever (server down, a lost turn.done).
  let holdingSince = 0; // unix ms the current keep-alive began, 0 when not holding
  let lastEventAt = 0;
  let guard: ReturnType<typeof setTimeout> | null = null;
  let checking = false;
  let check = 0; // an idle check still in flight is ignored once the hold ends or a newer one starts

  function render(force = false) {
    const view = viewOf(state);
    if (!view) {
      if (pending) clearTimeout(pending);
      pending = null;
      if (shown) status.clear();
      shown = null;
      release?.(); // idle: the stream may sleep in the background again
      release = null;
      armGuard();
      return;
    }
    release ??= transport.holdOpen(); // keep events coming while the status is up
    if (!askedPermission) {
      askedPermission = true;
      void status.ensurePermission().catch(() => false);
    }
    armGuard();
    if ((!force && sameView(view, shown)) || pending) return;
    // Starting or stopping the foreground service is never held back: only plain updates are throttled.
    const wait = shown && shown.keepAlive === view.keepAlive ? lastShownAt + MIN_UPDATE_MS - Date.now() : 0;
    if (wait > 0) {
      pending = setTimeout(() => {
        pending = null;
        flush(force);
      }, wait);
      return;
    }
    flush(force);
  }

  function flush(force = false) {
    const view = viewOf(state); // the newest, not the one that scheduled this
    if (!view || (!force && sameView(view, shown))) return;
    status.show(view); // a re-post also renews the native side's own timeout
    shown = view;
    lastShownAt = Date.now();
  }

  /**
   * One timer while holding, at the first of: the idle deadline, the max hold, and the refresh (a
   * held status is re-posted at least every IDLE_MS, so the native side's 20 min deadline, which
   * stops the foreground service, only fires when JS is gone).
   */
  function armGuard() {
    const holding = viewOf(state)?.keepAlive ?? false;
    if (!holding) {
      holdingSince = 0;
      if (guard) clearTimeout(guard);
      guard = null;
      check++; // an idle check in flight no longer matters
      return;
    }
    const now = Date.now();
    if (!holdingSince) holdingSince = now;
    if (guard || checking) return;
    const due = Math.min(lastEventAt + IDLE_MS, holdingSince + MAX_HOLD_MS, lastShownAt + IDLE_MS);
    guard = setTimeout(onGuard, Math.max(0, due - now));
  }

  function onGuard() {
    guard = null;
    const now = Date.now();
    if (holdingSince && now >= holdingSince + MAX_HOLD_MS) {
      drop(); // held too long, whatever the server says
      return;
    }
    if (now < lastEventAt + IDLE_MS) {
      if (now >= lastShownAt + IDLE_MS) flush(true); // busy but unchanged: renew the native deadlines
      armGuard(); // events came meanwhile: not idle
      return;
    }
    // Quiet for IDLE_MS: a long tool may simply be running. Ask the server rather than guess.
    checking = true;
    const mine = ++check;
    Promise.all([api.status({ timeoutMs: CHECK_TIMEOUT_MS }), api.permissions()]).then(
      ([st, waiting]) => {
        checking = false;
        if (mine !== check) return armGuard();
        lastEventAt = Date.now();
        apply(snapshot(st.runs, waiting));
        render(true); // re-post: renews the notification's native timeout
      },
      () => {
        checking = false;
        if (mine === check) drop(); // the server is unreachable: nothing is known to be running
      },
    );
  }

  /** Stop claiming work: no runs, no approvals (a later event or resync brings them back). */
  function drop() {
    apply({ ...state, runs: {}, approvals: {} });
    armGuard();
  }

  function snapshot(runsNow: Awaited<ReturnType<Api['status']>>['runs'], waiting: Awaited<ReturnType<Api['permissions']>>): LiveStatusState {
    const now = Date.now();
    const runs: Record<string, Run> = {};
    for (const r of runsNow) {
      const had = state.runs[r.ref];
      runs[r.ref] = { startedAt: now - r.seconds * 1000, lane: r.lane, steps: had?.steps ?? 0, step: r.step, tool: had?.tool ?? null };
    }
    const approvals: LiveStatusState['approvals'] = {};
    for (const p of waiting) approvals[p.id] = { tool: p.tool, detail: p.detail };
    return { ...state, runs, approvals };
  }

  function apply(next: LiveStatusState) {
    if (next === state) return;
    state = next;
    render();
  }

  function onEvent(e: EdithEvent) {
    if (e.type === 'app.connected') return;
    if (!e.type.startsWith('app.')) lastEventAt = Date.now();
    if (buffered && buffered.length < BUFFER_MAX) buffered.push(e);
    apply(reduce(state, e));
  }

  const offs = [
    bus.subscribe('*', onEvent, 'live-status'),
    bus.on(
      'app.connected',
      () => {
        // Events sent while disconnected are gone: take the server's view of runs and approvals,
        // then replay what arrived while it was in flight (a turn.done then must not be undone).
        const mine = ++sync;
        buffered = [];
        lastEventAt = Date.now();
        Promise.all([api.status(), api.permissions()]).then(
          ([st, waiting]) => {
            if (mine !== sync) return;
            const replay = buffered ?? [];
            buffered = null;
            apply(replay.reduce((s, e) => reduce(s, e), snapshot(st.runs, waiting)));
          },
          () => {
            if (mine === sync) buffered = null; // keep what we have; the next connect tries again
          },
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
      if (guard) clearTimeout(guard);
      sync++;
      check++;
      if (shown) status.clear();
      release?.();
    },
  };
}
