// The status panel's logic (StatusPanel.tsx draws it): the collapsed bar from the live store, kept
// current by stream events alone, and the open card's details fetch (contracts/status.md).

import type { StatusDetails } from '../../core/api';
import type { LiveState } from './model';

export type BarState = StatusDetails['edith']['state'];

export interface BarSummary {
  state: BarState;
  tone: 'idle' | 'busy' | 'approval';
  label: string; // "Running Bash", "Thinking", "Waiting for approval", "Idle"
  counts: string; // "1 parallel · 2 queued · 1 approval", or ""
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
  const counts = [side ? `${side} parallel` : '', s.queued ? `${s.queued} queued` : '', approvals ? plural(approvals, 'approval') : '']
    .filter(Boolean)
    .join(' · ');
  const prompt = s.items.find((x) => x.kind === 'user' && x.text.trim() !== ''); // newest first: stops at the latest
  const detail = main?.active && main.step ? main.step : prompt?.kind === 'user' ? prompt.text.trim() : null;
  if (approvals) return { state: 'waiting_approval', tone: 'approval', label: 'Waiting for approval', counts, detail };
  if (main?.active && main.step) return { state: 'tool', tone: 'busy', label: `Running ${toolName(main.step)}`, counts, detail };
  if (main || s.main === 'busy') return { state: 'thinking', tone: 'busy', label: 'Thinking', counts, detail };
  return { state: 'idle', tone: 'idle', label: 'Idle', counts, detail };
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

/** The state's label as the server describes it, for the open card. */
export function detailsLabel(e: StatusDetails['edith']): string {
  switch (e.state) {
    case 'tool':
      return `Running ${e.tool ?? (e.step ? toolName(e.step) : 'a tool')}`;
    case 'thinking':
      return 'Thinking';
    case 'waiting_approval':
      return `Waiting for approval${e.tool ? ` (${e.tool})` : ''}`;
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
