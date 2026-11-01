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
  results: string[]; // the edit tools' results (shown in the file's detail)
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

/**
 * The path in an edit tool's summary ("Edit: /x/y.ts" or "/x/y.ts"), or null. The server cuts
 * summaries to 120 characters, so a long path may be only its start (or, with a "…", its end).
 */
function editPath(t: ToolItem): string | null {
  if (!EDIT_TOOLS.has(t.name)) return null;
  const s = t.summary.replace(new RegExp(`^${t.name}:\\s*`), '').trim();
  return s.startsWith('/') || s.startsWith('~') || s.startsWith('…') ? s : null;
}

/** The diff path an edit tool's (maybe cut) path stands for: the same, or the one path it starts or ends, or null. */
function matchPath(path: string, diffPaths: readonly string[]): string | null {
  if (diffPaths.includes(path)) return path;
  const head = path.replace(/(…|\.\.\.)$/, '');
  const tail = path.replace(/^(…|\.\.\.)/, '');
  const found = diffPaths.filter((d) => (head.length >= 8 && d.startsWith(head)) || (tail !== path && tail.length >= 4 && d.endsWith(tail)));
  return found.length === 1 ? found[0]! : null;
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

export type DiffTone = 'header' | 'hunk' | 'add' | 'del' | 'ctx';
export interface DiffPart {
  text: string;
  tone: DiffTone;
}

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * A unified diff's lines, each with its part. Inside a hunk the @@ counts say how many lines it
 * holds, so a removed "---" (YAML), "-- sql", "--i;" or "++count;" stays a line. Outside one,
 * ---/+++ are headers only right before an @@ (a MultiEdit diff repeats them per edit).
 */
export function diffParts(diff: string): DiffPart[] {
  const lines = diff.replace(/\n$/, '').split('\n');
  const out: DiffPart[] = [];
  let oldLeft = 0;
  let newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('\\')) out.push({ text: line, tone: 'ctx' }); // "\ No newline at end of file"
      else if (line.startsWith('+')) {
        newLeft--;
        out.push({ text: line, tone: 'add' });
      } else if (line.startsWith('-')) {
        oldLeft--;
        out.push({ text: line, tone: 'del' });
      } else {
        oldLeft--;
        newLeft--;
        out.push({ text: line, tone: 'ctx' });
      }
      continue;
    }
    const m = HUNK.exec(line);
    if (m) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
      out.push({ text: line, tone: 'hunk' });
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++')) {
      let j = i;
      while (j < lines.length && (lines[j]!.startsWith('---') || lines[j]!.startsWith('+++'))) j++;
      if (j < lines.length && lines[j]!.startsWith('@@')) {
        for (; i < j; i++) out.push({ text: lines[i]!, tone: 'header' });
        i--;
        continue;
      }
    }
    // Outside a hunk (a loose diff): by its first character.
    out.push({ text: line, tone: line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx' });
  }
  return out;
}

/** Lines added and removed in a unified diff (not counting its ---/+++ headers). */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of diffParts(diff)) {
    if (p.tone === 'add') added++;
    else if (p.tone === 'del') removed++;
  }
  return { added, removed };
}

/** A diff for reading: without its ---/+++ headers (long absolute paths); hunks and lines kept. */
export function readableDiff(diff: string): string[] {
  return diffParts(diff)
    .filter((p) => p.tone !== 'header')
    .map((p) => p.text);
}

/** A group's steps, its edits merged per file, and its counts. */
export function summarize(group: WorkGroup): WorkSummary {
  const steps: Step[] = [];
  const entries: Entry[] = [];
  const files = new Map<string, FileEdit>();
  // File rows are keyed only by the diffs' paths (full); an edit tool's summary may be cut short.
  const diffPaths = [...new Set(group.items.flatMap((x) => (x.kind === 'diff' ? [x.path] : [])))];
  const fileOf = (path: string) => {
    let f = files.get(path);
    if (!f) {
      const where = shortPath(path);
      files.set(path, (f = { path, name: where.slice(where.lastIndexOf('/') + 1), where, added: 0, removed: 0, diffs: [], results: [] }));
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
    // A successful edit with a diff is its file's row (its result kept in the file's detail); a
    // failed or running one, or one without a diff, stays a step (with the file's name).
    const file = path && x.status === 'ok' ? matchPath(path, diffPaths) : null;
    if (file) {
      const f = fileOf(file);
      if (x.result) f.results.push(x.result);
      continue;
    }
    if (path) step.label = `${x.status === 'error' ? 'Couldn’t edit' : x.status === 'running' ? 'Editing' : 'Edited'} ${shortPath(path).split('/').pop()}`;
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
