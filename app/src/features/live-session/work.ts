// The Work card (Arpit, 1 Nov: "show bash commands and edits in a better and more meaningful
// way"): a turn's consecutive tool calls and file edits become one row of the transcript, summed
// up in a line ("✓ 7 steps · 2 files changed · 1m 40s") and opened on tap. Pure: the grouping, the
// steps in plain language, the edits merged per file, the summary; WorkCard draws them.
//
// Cost: the grouping is one pass over the items, and each group is kept from the last pass while
// its members are the same objects (the reducer keeps unchanged items as they were), so the list
// sees the same row objects and memoised rows don't re-render. A group's steps and files are only
// worked out when its card draws (WorkCard memoises them per group).

import { stepKind, stepLabel, type StepKind } from './steps';
import type { Item } from './model';

export type ToolItem = Extract<Item, { kind: 'tool' }>;
export type DiffItem = Extract<Item, { kind: 'diff' }>;
export type WorkItem = ToolItem | DiffItem;

/** One Work card: consecutive tool and diff items, oldest first. `id` is the oldest member's (it never changes as steps are added). */
export interface WorkGroup {
  kind: 'work';
  id: number;
  ts: number;
  items: readonly WorkItem[];
  until: number | null; // when the work ended: the next (newer) row's time, null while nothing came after
}

/** A transcript row: a message (or other item), or a Work card. */
export type Row = Exclude<Item, WorkItem> | WorkGroup;

/** How much a Work card shows (Settings → Chat → Work details). */
export type WorkDetail = 'summary' | 'steps' | 'full';
export const WORK_DETAILS: readonly { id: WorkDetail; name: string; hint: string }[] = [
  { id: 'summary', name: 'Summary', hint: 'One line per turn; tap it for the steps.' },
  { id: 'steps', name: 'Steps', hint: 'The live step while EDITH works, a line when done; tap for the steps.' },
  { id: 'full', name: 'Full', hint: 'Every step and edit, open: commands, results and diffs.' },
];
export const DEFAULT_WORK_DETAIL: WorkDetail = 'steps';
export const isWorkDetail = (v: unknown): v is WorkDetail => v === 'summary' || v === 'steps' || v === 'full';

const isWork = (x: Item): x is WorkItem => x.kind === 'tool' || x.kind === 'diff';

/**
 * Items (newest first, as the list holds them) as rows: each run of tool and diff items becomes
 * one WorkGroup. `previous` is the last result's groups by id: one with the same members is reused.
 */
export function groupRows(items: readonly Item[], previous: ReadonlyMap<number, WorkGroup> = new Map()): { rows: Row[]; groups: Map<number, WorkGroup> } {
  const rows: Row[] = [];
  const groups = new Map<number, WorkGroup>();
  for (let i = 0; i < items.length; ) {
    const x = items[i]!;
    if (!isWork(x)) {
      rows.push(x);
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && isWork(items[j]!)) j++;
    // items[i..j) newest first: the group holds them oldest first.
    const oldest = items[j - 1]!;
    const until = i > 0 ? items[i - 1]!.ts : null;
    const was = previous.get(oldest.id);
    const n = j - i;
    let same = !!was && was.items.length === n && was.until === until;
    for (let k = 0; same && k < n; k++) if (was!.items[k] !== items[j - 1 - k]) same = false;
    const group: WorkGroup = same ? was! : { kind: 'work', id: oldest.id, ts: oldest.ts, items: items.slice(i, j).reverse() as WorkItem[], until };
    groups.set(group.id, group);
    rows.push(group);
    i = j;
  }
  return { rows, groups };
}

// ---- inside a group ----

export interface Step {
  id: number;
  kind: StepKind;
  label: string; // plain language: the description, no "Bash $"
  raw: string; // the tool and its summary as sent (the command): the expanded detail
  status: ToolItem['status'];
  result: string | null;
}

export interface FileEdit {
  path: string;
  name: string; // the file's name
  where: string; // its repo-relative path (dim subtext)
  added: number;
  removed: number;
  diffs: string[]; // each edit's diff, in order (merged: one row per file per turn)
}

export type Entry = { type: 'step'; step: Step } | { type: 'file'; file: FileEdit };

export interface WorkSummary {
  entries: Entry[]; // in order: each step, and each file where it was first edited
  steps: Step[]; // every step but successful edits (those are `files`)
  files: FileEdit[];
  count: number; // steps shown in the summary: tools run
  failed: number;
  running: Step | null; // the step running now
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** The path in an edit tool's summary ("Edit: /x/y.ts" or "/x/y.ts"), or null. */
function editPath(t: ToolItem): string | null {
  if (!EDIT_TOOLS.has(t.name)) return null;
  const s = t.summary.replace(new RegExp(`^${t.name}:\\s*`), '').trim();
  return s.startsWith('/') || s.startsWith('~') ? s : null;
}

/** A path made short: the repo-relative part ("app/src/x.ts") where it's under a project; home-relative otherwise. */
export function shortPath(path: string): string {
  let p = path.replace(/^\/home\/[^/]+\//, '').replace(/^~\//, '');
  p = p.replace(/^.*?\.claude\/worktrees\/[^/]+\//, '');
  const parts = p.split('/');
  // Projects/[Personal Projects/]<repo>/rest → rest
  if (parts[0] === 'Projects' || parts[0] === 'projects') {
    let k = 1;
    if (parts.length > 3 && /projects$/i.test(parts[k]!)) k++;
    return parts.slice(k + 1).join('/') || p;
  }
  return p;
}

/** Lines added and removed in a unified diff (not counting its ---/+++ headers). */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/** A diff for reading: without its ---/+++ headers (long absolute paths); hunks and lines kept. */
export function readableDiff(diff: string): string[] {
  return diff
    .replace(/\n$/, '')
    .split('\n')
    .filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ ') && l !== '---' && l !== '+++');
}

/** A group's steps, its edits merged per file, and its counts. */
export function summarize(group: WorkGroup): WorkSummary {
  const steps: Step[] = [];
  const entries: Entry[] = [];
  const files = new Map<string, FileEdit>();
  const fileOf = (path: string) => {
    let f = files.get(path);
    if (!f) {
      const where = shortPath(path);
      files.set(path, (f = { path, name: where.slice(where.lastIndexOf('/') + 1), where, added: 0, removed: 0, diffs: [] }));
      entries.push({ type: 'file', file: f });
    }
    return f;
  };
  let count = 0;
  let failed = 0;
  let running: Step | null = null;
  for (const x of group.items) {
    if (x.kind === 'diff') {
      const f = fileOf(x.path);
      const c = diffCounts(x.diff);
      f.added += c.added;
      f.removed += c.removed;
      f.diffs.push(x.diff);
      continue;
    }
    count++;
    if (x.status === 'error') failed++;
    const path = editPath(x);
    const step: Step = { id: x.id, kind: stepKind(x.name, x.summary), label: stepLabel(x.name, x.summary), raw: x.summary ? `${x.name}: ${x.summary.replace(/^\s*\$\s*/, '$ ')}` : x.name, status: x.status, result: x.result };
    if (x.status === 'running') running = step;
    // A successful edit is its file's row; a failed or running one stays a step (with the file's name).
    if (path && x.status === 'ok') {
      fileOf(path);
      continue;
    }
    if (path) step.label = `${x.status === 'error' ? 'Couldn’t edit' : 'Editing'} ${shortPath(path).split('/').pop()}`;
    steps.push(step);
    entries.push({ type: 'step', step });
  }
  return { entries, steps, files: [...files.values()], count, failed, running };
}

/** "1m 40s", "12s". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

/** The done line: "7 steps · 2 files changed · 1m 40s" (the ✓ or the failures are drawn by the card). */
export function summaryLine(sum: WorkSummary, seconds: number): string {
  const parts = [`${sum.count} ${sum.count === 1 ? 'step' : 'steps'}`];
  const changed = sum.files.filter((f) => f.diffs.length).length;
  if (changed) parts.push(`${changed} ${changed === 1 ? 'file' : 'files'} changed`);
  if (seconds >= 1) parts.push(duration(seconds));
  return parts.join(' · ');
}
