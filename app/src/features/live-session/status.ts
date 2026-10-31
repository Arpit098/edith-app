// The status panel's logic (StatusPanel.tsx draws it): the collapsed bar from the live store, kept
// current by stream events alone, and the open card's details fetch (contracts/status.md).

import type { BackgroundJob, StatusDetails } from '../../core/api';
import type { Store } from '../../core/store';
import type { LiveState, TurnStart } from './model';

export type BarState = StatusDetails['edith']['state'];

export interface BarSummary {
  state: BarState;
  // waiting: EDITH's turn is over but work it started runs on in the background. Calm, not working:
  // no turn timer, and Stop has no turn to end.
  tone: 'idle' | 'busy' | 'approval' | 'waiting';
  label: string; // "Running Bash", "Thinking", "Waiting for approval", "Waiting on background work", "Idle"
  counts: string; // "1 parallel · 2 queued · 1 approval · 1 bg", or ""
  background: number; // background jobs running
  // The pill's right side: the step running ("$ npm test") or, between steps, Arpit's latest prompt.
  // Never the session's title, which is often a long first message (it's in the card, labelled).
  detail: string | null;
}

/** "$ npm test" -> "Bash", "Read: x.py" -> "Read": the tool behind a step summary (server/…/transcript.py describe_tool). */
export function toolName(step: string): string {
  if (step.startsWith('$ ')) return 'Bash';
  const m = /^([A-Za-z][\w.-]*): /.exec(step);
  const name = m ? m[1]! : step.trim();
  return name.length > 24 ? `${name.slice(0, 23)}…` : name;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function barSummary(s: LiveState): BarSummary {
  const runs = Object.values(s.runs);
  const main = runs.find((r) => r.lane === 'main') ?? runs[0];
  const approvals = Object.keys(s.approvals).length;
  const side = runs.filter((r) => r.lane === 'side').length;
  const background = s.background.length;
  const counts = [side ? `${side} parallel` : '', s.queued ? `${s.queued} queued` : '', approvals ? plural(approvals, 'approval') : '', background ? `${background} bg` : '']
    .filter(Boolean)
    .join(' · ');
  const prompt = s.items.find((x) => x.kind === 'user' && x.text.trim() !== ''); // newest first: stops at the latest
  const detail = main?.active && main.step ? main.step : prompt?.kind === 'user' ? prompt.text.trim() : null;
  const bar = { counts, detail, background };
  if (approvals) return { state: 'waiting_approval', tone: 'approval', label: 'Waiting for approval', ...bar };
  if (main?.active && main.step) return { state: 'tool', tone: 'busy', label: `Running ${toolName(main.step)}`, ...bar };
  if (main || s.main === 'busy') return { state: 'thinking', tone: 'busy', label: 'Thinking', ...bar };
  if (background) return { state: 'waiting', tone: 'waiting', label: 'Waiting on background work', ...bar, detail: s.background[0]!.label };
  return { state: 'idle', tone: 'idle', label: 'Idle', ...bar };
}

const KIND: Record<BackgroundJob['kind'], string> = { shell: 'Shell', agent: 'Agent' };

/** How long a job has run: "<1 min", "3 min", "1 h 5 min". */
export function formatRunFor(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  if (m < 1) return '<1 min';
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

/** "Shell · Wait for PR 41 CI · 3 min"; `now` on the same clock as `started` (the server's). */
export function backgroundLine(job: BackgroundJob, now: number): string {
  return [KIND[job.kind], job.label, job.started != null ? formatRunFor(now - job.started) : null].filter(Boolean).join(' · ');
}

/**
 * What Stop says while only background work runs: there is no turn for it to end, and it doesn't
 * cancel that work (POST /v1/stop ends turns only). `request` is the message that asks EDITH to.
 */
export function backgroundStopPrompt(jobs: BackgroundJob[], now: number): { title: string; message: string; request: string } {
  const n = jobs.length;
  return {
    title: n === 1 ? 'Background work running' : `${n} background jobs running`,
    message:
      `EDITH's reply is done, so Stop has no turn to end, and it doesn't cancel ${n === 1 ? 'this' : 'these'}:\n` +
      jobs.map((j) => `• ${backgroundLine(j, now)}`).join('\n') +
      `\n\n${n === 1 ? 'It reports' : 'They report'} back when done. Ask EDITH to cancel ${n === 1 ? 'it' : 'them'}?`,
    request: `Please cancel your background work: ${jobs.map((j) => j.label).join('; ')}.`,
  };
}

/** "0:42", "12:05", "1:02:03" */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor((s % 3600) / 60));
  const ss = String(s % 60).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/** "3d 4h", "5h 12m", "12m", "40s" */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`;
}

/** 320562 -> "321k", 1_250_000 -> "1.25M" */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** "just now", "3 min ago", "2 h 5 min ago", "3 d ago": how long ago, for the card. */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 45) return 'just now';
  const min = Math.max(1, Math.round(s / 60));
  if (min < 60) return `${min} min ago`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h} h ${m} min ago` : `${h} h ago`;
  }
  return `${Math.floor(s / 86400)} d ago`;
}

/**
 * Claude's context window sizes, smallest first. The server sends only the tokens in use
 * (contracts/status.md), so the window is taken as the smallest one that fits them: 200k normally,
 * 1M once a session has gone past 200k (only the long-context models get there).
 */
export const CONTEXT_WINDOWS = [200_000, 1_000_000] as const;

/** "120k of 200k" and how full (0..1) for the thin bar; only the tokens if they outgrow every window. */
export function contextUsage(tokens: number): { text: string; fraction: number | null } {
  const max = CONTEXT_WINDOWS.find((w) => tokens <= w);
  if (max == null) return { text: `${formatTokens(tokens)} tokens`, fraction: null };
  return { text: `${formatTokens(tokens)} of ${formatTokens(max)}`, fraction: tokens / max };
}

export type AgentTone = 'busy' | 'idle' | 'warn' | 'danger';

/** A coding agent's chip: "Busy", "Idle", "Needs approval" or "Usage limit", and its colour. */
export function agentChip(a: StatusDetails['agents'][number]): { label: string; tone: AgentTone } {
  if (a.blocked === 'usage_limit') return { label: 'Usage limit', tone: 'danger' };
  if (a.blocked === 'permission' || a.state === 'blocked') return { label: 'Needs approval', tone: 'warn' };
  // Its turn is over; a shell or subagent it started runs on: calm, like idle, but said.
  if (a.state === 'waiting') return { label: a.background === 'shell' ? 'Waiting · bg shell' : 'Waiting · bg work', tone: 'idle' };
  return a.state === 'busy' ? { label: 'Busy', tone: 'busy' } : { label: 'Idle', tone: 'idle' };
}

/** The state's label as the server describes it, for the open card. */
export function detailsLabel(e: StatusDetails['edith']): string {
  switch (e.state) {
    case 'tool':
      return `Running ${e.tool ?? (e.step ? toolName(e.step) : 'a tool')}`;
    case 'thinking':
      return 'Thinking';
    case 'waiting_approval':
      return `Waiting for approval${e.tool ? ` (${e.tool})` : ''}`;
    case 'waiting':
      return 'Reply done · waiting on background work';
    default:
      return 'Idle';
  }
}

/** The running main turn (or any run): its ref and the server's elapsed seconds at its last event. */
export function mainRun(s: LiveState): { ref: string | null; elapsed: number | null } {
  const refs = Object.keys(s.runs);
  const ref = refs.find((r) => s.runs[r]!.lane === 'main') ?? refs[0] ?? null;
  return { ref, elapsed: ref ? s.runs[ref]!.elapsed : null };
}

/**
 * When the running turn began, on the phone's clock: counted back from now by the server's elapsed
 * (correct even if the app opened mid-turn, whatever the clock offset), or `startedHere` (the moment
 * work began here) when no event has carried an elapsed time yet. Call it when `elapsed` changes.
 */
export function turnSince(elapsed: number | null, now: number, startedHere: number): number {
  return elapsed != null && elapsed > 0 ? now - elapsed : startedHere;
}

/**
 * The turn start the state should hold at `now` (pure): null while idle; kept while the same main
 * run goes on with no new elapsed; else counted back from the server's elapsed when an event carried
 * one (turnSince), or `now` for a new run (or EDITH going busy) with none yet.
 */
export function nextTurnStart(s: LiveState, now: number): TurnStart | null {
  if (barSummary(s).tone === 'idle') return null;
  const { ref, elapsed } = mainRun(s);
  const prev = s.turnStart;
  if (prev && prev.ref === ref && prev.elapsed === elapsed) return prev;
  const startedHere = prev && prev.ref === ref ? prev.at : now; // same run, a new elapsed: re-anchor only on it
  return { ref, elapsed, at: turnSince(elapsed, now, startedHere) };
}

/**
 * Keeps `turnStart` in the live store current: one shared start time, so the chip and the card
 * (which GrowSheet remounts on every open) always show the same turn time. Returns unsubscribe.
 */
export function trackTurnStart(store: Store<LiveState>, now: () => number = () => Date.now() / 1000): () => void {
  const sync = () => {
    const s = store.get();
    const next = nextTurnStart(s, now());
    if (next !== s.turnStart) store.set({ ...s, turnStart: next });
  };
  sync();
  return store.subscribe(sync); // a set from here re-runs sync once, which then finds nothing to do
}

/**
 * Fetch the details now, then `everyMs` after each answer (never two at once), until the returned
 * stop() is called; results that land after stop() are dropped. Runs only while the card is open.
 */
export function pollDetails(
  fetch: () => Promise<StatusDetails>,
  onResult: (r: { details: StatusDetails; at: number } | { error: string }) => void,
  everyMs: number,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    fetch().then(
      (details) => !stopped && onResult({ details, at: Date.now() / 1000 }),
      (e: unknown) => !stopped && onResult({ error: e instanceof Error ? e.message : String(e) }),
    ).finally(() => {
      if (!stopped) timer = setTimeout(run, everyMs);
    });
  };
  run();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
