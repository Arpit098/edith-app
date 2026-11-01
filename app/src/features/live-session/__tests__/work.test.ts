// The Work card's maths: tool runs grouped into one row per turn (kept as the same object while
// unchanged), edits merged per file with +N −M, short paths, diffs without their path headers, the
// summary line and failures; and the Work details setting kept on the phone.

import { MemoryStorage } from '../../../testing/fakes';
import { createWorkDetailSetting, WORK_DETAIL_KEY } from '../chatSettings';
import type { Item } from '../model';
import { diffCounts, diffParts, duration, groupRows, readableDiff, shortPath, summarize, summaryLine, type WorkGroup } from '../work';

let n = 0;
const at = (ts: number) => ({ id: ++n, ts });
const user = (text: string, ts = 0): Item => ({ kind: 'user', ...at(ts), text, origin: 'app', voice: false, ref: null, delivery: null, local: null, echoed: true, reaction: null, attachments: [], replyTo: null }) as Item;
const answer = (text: string, ts = 0): Item => ({ kind: 'assistant', ...at(ts), text, lane: null, ref: null });
const tool = (name: string, summary: string, status: 'running' | 'ok' | 'error' = 'ok', ts = 0, result: string | null = null): Item => ({ kind: 'tool', ...at(ts), name, summary, status, result });
const diff = (path: string, body: string, ts = 0): Item => ({ kind: 'diff', ...at(ts), path, diff: body });

const ABS = '/home/ubuntu/Projects/Personal Projects/edith-app/app/src/features/live-session/LiveScreen.tsx';
const DIFF = `--- a/${ABS}\n+++ b/${ABS}\n@@ -1,2 +1,2 @@\n-old line\n+new line\n+another\n context\n`;

/** Oldest first, as events arrive; the list holds them newest first. */
const newestFirst = (...items: Item[]) => [...items].reverse();

describe('grouping', () => {
  it('a turn’s consecutive tool calls and diffs are one Work card between the messages', () => {
    const q = user('fix it', 0);
    const t1 = tool('Bash', '$ Find the placeholder', 'ok', 1);
    const t2 = tool('Edit', `Edit: ${ABS}`, 'ok', 2);
    const d = diff(ABS, DIFF, 2);
    const a = answer('Done.', 9);
    const { rows } = groupRows(newestFirst(q, t1, t2, d, a));
    expect(rows.map((r) => r.kind)).toEqual(['assistant', 'work', 'user']);
    const g = rows[1] as WorkGroup;
    expect(g.items).toEqual([t1, t2, d]); // oldest first
    expect(g.id).toBe(t1.id); // the oldest's id: stable as steps are added
    expect([g.ts, g.until]).toEqual([1, 9]); // started, and ended when the answer came
  });

  it('keeps a group as the same object while its members are the same (memoised rows don’t re-render)', () => {
    const t1 = tool('Bash', '$ ls', 'ok', 1);
    const first = groupRows(newestFirst(user('a'), t1));
    const again = groupRows(newestFirst(user('a'), t1).map((x) => x), first.groups);
    expect(again.rows[0]).toBe(first.rows[0]);
    // A new step: a new group object (the same id).
    const t2 = tool('Bash', '$ ls -la', 'running', 2);
    const grown = groupRows([t2, t1, ...first.rows.slice(1)] as Item[], again.groups);
    expect(grown.rows[0]).not.toBe(first.rows[0]);
    expect((grown.rows[0] as WorkGroup).id).toBe(t1.id);
  });

  it('hundreds of tool items group in one pass', () => {
    const items: Item[] = [];
    for (let t = 0; t < 200; t++) items.push(user(`q${t}`), ...Array.from({ length: 10 }, (_, k) => tool('Bash', `$ step ${k}`)), answer('ok'));
    const list = newestFirst(...items);
    const start = Date.now();
    const { rows, groups } = groupRows(list);
    const again = groupRows(list, groups);
    expect(Date.now() - start).toBeLessThan(200);
    expect(rows).toHaveLength(600);
    expect(again.rows.every((r, i) => r === rows[i])).toBe(true);
  });
});

describe('inside a card', () => {
  const group = (...items: Item[]): WorkGroup => groupRows(newestFirst(...items)).rows.find((r) => r.kind === 'work') as WorkGroup;

  it('steps in plain language; several edits to one file are one row with summed +N −M', () => {
    const g = group(
      tool('Bash', '$ Find BUSY_PLACEHOLDER uses'),
      tool('Edit', `Edit: ${ABS}`),
      diff(ABS, DIFF),
      tool('Bash', '$ Run the app tests'),
      tool('Edit', `Edit: ${ABS}`),
      diff(ABS, `--- a/${ABS}\n+++ b/${ABS}\n@@ -9 +9 @@\n-x\n+y\n`),
    );
    const s = summarize(g);
    expect(s.steps.map((x) => [x.kind, x.label])).toEqual([
      ['search', 'Find BUSY_PLACEHOLDER uses'],
      ['test', 'Run the app tests'],
    ]);
    expect(s.steps[0]!.raw).toBe('Bash: $ Find BUSY_PLACEHOLDER uses'); // the command, for the detail view
    expect(s.files).toHaveLength(1);
    expect(s.files[0]).toMatchObject({ name: 'LiveScreen.tsx', where: 'app/src/features/live-session/LiveScreen.tsx', added: 3, removed: 2 });
    expect(s.files[0]!.diffs).toHaveLength(2);
    expect(s.entries.map((e) => (e.type === 'step' ? e.step.label : e.file.name))).toEqual(['Find BUSY_PLACEHOLDER uses', 'LiveScreen.tsx', 'Run the app tests']);
    expect(s.count).toBe(4);
    expect(summaryLine(s, 100)).toBe('4 steps · 1 file changed · 1m 40s');
  });

  it('a failure is counted and stays a red step (a failed edit too, named by its file)', () => {
    const s = summarize(group(tool('Bash', '$ Run the tests', 'error', 0, '3 failed'), tool('Edit', `Edit: ${ABS}`, 'error', 0, 'old_string not found')));
    expect(s.failed).toBe(2);
    expect(s.steps.map((x) => [x.status, x.label])).toEqual([
      ['error', 'Run the tests'],
      ['error', 'Couldn’t edit LiveScreen.tsx'],
    ]);
    expect(s.files).toEqual([]);
  });

  it('a long path cut to 120 characters in the tool summary is still the one file row (matched to its diff)', () => {
    const long = `/home/ubuntu/Projects/Personal Projects/edith-app/.claude/worktrees/agent-a1b2c3d4/app/src/features/live-session/__tests__/WorkCard.test.tsx`;
    const summary = `Edit: ${long}`.slice(0, 120);
    expect(summary.length).toBe(120);
    const s = summarize(group(tool('Edit', summary, 'ok', 0, 'The file has been updated successfully.'), diff(long, `--- a/${long}\n+++ b/${long}\n@@ -1 +1 @@\n-a\n+b\n`)));
    expect(s.files.map((f) => f.path)).toEqual([long]);
    expect(s.files[0]!.results).toEqual(['The file has been updated successfully.']); // the tool's result, in the file's detail
    expect(s.steps).toEqual([]);
    expect(summaryLine(s, 0)).toBe('1 step · 1 file changed');
  });

  it('an edit without a diff is an edit step, not a second file row', () => {
    const s = summarize(group(tool('Write', `Write: /home/ubuntu/edith/notes.md`), tool('Edit', `Edit: ${ABS}`), diff(ABS, DIFF)));
    expect(s.files.map((f) => f.where)).toEqual(['app/src/features/live-session/LiveScreen.tsx']);
    expect(s.steps.map((x) => [x.kind, x.label])).toEqual([['edit', 'Edited notes.md']]);
    expect(summaryLine(s, 0)).toBe('2 steps · 1 file changed');
  });

  it('the running step is the live one', () => {
    const s = summarize(group(tool('Bash', '$ Install'), tool('Bash', '$ Run tests', 'running')));
    expect(s.running?.label).toBe('Run tests');
  });

  it('short paths, counts, readable diffs and durations', () => {
    expect(shortPath(ABS)).toBe('app/src/features/live-session/LiveScreen.tsx');
    expect(shortPath('/home/ubuntu/Projects/edith-app/server/x.py')).toBe('server/x.py');
    expect(shortPath('/home/ubuntu/edith/bridge/main.py')).toBe('edith/bridge/main.py');
    expect(shortPath('/home/ubuntu/Projects/Personal Projects/edith-app/.claude/worktrees/agent-1/app/a.ts')).toBe('app/a.ts');
    expect(diffCounts(DIFF)).toEqual({ added: 2, removed: 1 });
    expect(readableDiff(DIFF)).toEqual(['@@ -1,2 +1,2 @@', '-old line', '+new line', '+another', ' context']); // no a/ b/ headers
    expect([duration(12), duration(60), duration(100), duration(-3)]).toEqual(['12s', '1m', '1m 40s', '0s']);
  });

  it('---/+++ are headers only right before a hunk: SQL comments, --i, ++count and a YAML --- are lines', () => {
    const d = `--- a/x\n+++ b/x\n@@ -1,4 +1,4 @@\n--- sql comment\n+-- sql: a comment\n---i;\n+++count;\n ctx\n----\n+---\n`;
    expect(diffCounts(d)).toEqual({ added: 3, removed: 3 });
    expect(readableDiff(d)).toEqual(['@@ -1,4 +1,4 @@', '--- sql comment', '+-- sql: a comment', '---i;', '+++count;', ' ctx', '----', '+---']);
    expect(diffParts(d).filter((p) => p.tone === 'header').map((p) => p.text)).toEqual(['--- a/x', '+++ b/x']);
  });

  it('a MultiEdit diff repeats its headers per edit: each pair is left out, the lines counted', () => {
    const d = `--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n--- a/x\n+++ b/x\n@@ -9,2 +9 @@\n-c\n ---\n`;
    expect(diffCounts(d)).toEqual({ added: 1, removed: 2 });
    expect(readableDiff(d)).toEqual(['@@ -1 +1 @@', '-a', '+b', '@@ -9,2 +9 @@', '-c', ' ---']);
  });
});

describe('the Work details setting', () => {
  it('defaults to Steps, is kept on the phone, and a choice made before the read wins', async () => {
    const data = new MemoryStorage();
    const s = createWorkDetailSetting(data);
    expect(s.store.get()).toBe('steps');
    s.set('full');
    expect(data.data.get(WORK_DETAIL_KEY)).toBe('full');
    const again = createWorkDetailSetting(data);
    await again.load();
    expect(again.store.get()).toBe('full');
    data.data.set(WORK_DETAIL_KEY, 'nonsense');
    const garbled = createWorkDetailSetting(data);
    await garbled.load();
    expect(garbled.store.get()).toBe('steps');
    data.data.set(WORK_DETAIL_KEY, 'summary');
    const early = createWorkDetailSetting(data);
    early.set('full');
    await early.load();
    expect(early.store.get()).toBe('full');
  });
});
