// The Work card on screen: a done turn is one closed line ("✓ 3 steps · 1 file changed · 1m 40s")
// that opens on tap; a failure opens it by itself with a red step and "· 1 failed"; while the turn
// runs, the live step, a timer and the last steps faded; it closes again when the answer comes; the
// three detail levels; a file row opens the full-screen diff without its absolute-path headers.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Item } from '../model';
import { WorkCard, WorkDetailContext } from '../WorkCard';
import { groupRows, type WorkDetail, type WorkGroup } from '../work';

let n = 0;
const tool = (name: string, summary: string, status: 'running' | 'ok' | 'error' = 'ok', result: string | null = null, ts = 0): Item => ({ kind: 'tool', id: ++n, ts, name, summary, status, result });
const diff = (path: string, body: string, ts = 0): Item => ({ kind: 'diff', id: ++n, ts, path, diff: body });
const answer = (ts: number): Item => ({ kind: 'assistant', id: ++n, ts, text: 'Done.', lane: null, ref: null });
const ABS = '/home/ubuntu/Projects/Personal Projects/edith-app/app/src/a.ts';
const DIFF = `--- a/${ABS}\n+++ b/${ABS}\n@@ -1 +1 @@\n-old\n+new\n`;

function groupOf(items: Item[], until: number | null = 100): WorkGroup {
  const list = [...items].reverse();
  const rows = groupRows(until === null ? list : [answer(until), ...list]).rows;
  return rows.find((r) => r.kind === 'work') as WorkGroup;
}

function render(group: WorkGroup, live = false, detail: WorkDetail = 'steps') {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <WorkDetailContext.Provider value={detail}>
          <WorkCard group={group} live={live} />
        </WorkDetailContext.Provider>
      </SafeAreaProvider>,
    );
  });
  return r;
}
const METRICS = { frame: { x: 0, y: 0, width: 400, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };
/** A Text's own strings (nested Texts and icons left out). */
const own = (t: ReactTestInstance) =>
  [t.props.children]
    .flat()
    .filter((c): c is string | number => typeof c === 'string' || typeof c === 'number')
    .join('');
const texts = (r: ReactTestRenderer | ReactTestInstance) => ('root' in r ? r.root : r).findAllByType(Text).map(own).join(' | ');
const head = (r: ReactTestRenderer) => r.root.find((x) => x.props.accessibilityRole === 'button' && x.props.accessibilityState?.expanded !== undefined && /^(Work|Working)/.test(String(x.props.accessibilityLabel)));
const host = (r: ReactTestRenderer, id: string) => r.root.findAll((x) => typeof x.type === 'string' && x.props.testID === id);
const steps = (r: ReactTestRenderer) => r.root.findAll((x) => typeof x.props.testID === 'string' && x.props.testID.startsWith('work-step-') && typeof x.props.onPress === 'function' && typeof x.type !== 'string');

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const DONE = [tool('Bash', '$ Find the placeholder'), tool('Edit', `Edit: ${ABS}`), diff(ABS, DIFF), tool('Bash', '$ Run the app tests')];

describe('the Work card', () => {
  it('done: one closed line with the counts; tap opens the steps and the file row', () => {
    const r = render(groupOf(DONE.map((x) => ({ ...x }))));
    expect(texts(r)).toContain('3 steps · 1 file changed · 1m 40s');
    expect(steps(r)).toHaveLength(0); // closed: no step rows rendered at all
    act(() => head(r).props.onPress());
    expect(texts(r)).toContain('Find the placeholder');
    expect(texts(r)).toContain('Run the app tests');
    expect(texts(r)).not.toContain('Bash $');
    expect(texts(r)).toContain('a.ts');
    expect(texts(r)).toContain('app/src/a.ts');
    expect(texts(r)).toContain('+1');
    // A step shows its raw command only when tapped.
    expect(texts(r)).not.toContain('Bash: $ Run the app tests');
    act(() => steps(r)[1]!.props.onPress());
    expect(texts(r)).toContain('Bash: $ Run the app tests');
  });

  it('a failure opens the card by itself: a red step with its result, and "1 failed" in the line', () => {
    const r = render(groupOf([tool('Bash', '$ Run the tests', 'error', '2 tests failed'), tool('Bash', '$ ls')]));
    expect(texts(r)).toContain('2 steps · 1m 40s');
    expect(texts(r)).toContain(' · 1 failed'); // in red, its own Text
    expect(steps(r)).toHaveLength(2);
    expect(texts(r)).toContain('2 tests failed'); // the failed step opened itself
    expect(head(r).props.accessibilityLabel).toContain('1 failed');
  });

  it('live: the running step with a timer and the last steps faded; closes again when the answer comes', () => {
    jest.useFakeTimers();
    const now = Date.now() / 1000;
    const items = [tool('Bash', '$ Install', 'ok', null, now - 65), tool('Bash', '$ Build', 'ok', null, now - 30), tool('Bash', '$ Run tests', 'running', null, now - 5)];
    const live = groupOf(items, null);
    const r = render(live, true);
    expect(texts(r)).toContain('Run tests…');
    expect(texts(r)).toContain('1m 5s');
    act(() => jest.advanceTimersByTime(2000));
    expect(texts(r)).toContain('1m 7s');
    const recent = host(r, 'work-recent')[0]!;
    expect(recent.findAllByType(Text).map(own).filter((s) => /[a-z]/i.test(s))).toEqual(['Install', 'Build']); // icons left out
    // Opened by hand while it runs, then the answer arrives: closed again, the summary line.
    act(() => head(r).props.onPress());
    expect(steps(r).length).toBeGreaterThan(0);
    const done = groupOf(items.map((x) => (x.kind === 'tool' ? { ...x, status: 'ok' as const } : x)), now);
    act(() =>
      r.update(
        <SafeAreaProvider initialMetrics={METRICS}>
          <WorkDetailContext.Provider value="steps">
            <WorkCard group={done} live={false} />
          </WorkDetailContext.Provider>
        </SafeAreaProvider>,
      ),
    );
    expect(steps(r)).toHaveLength(0);
    expect(texts(r)).toContain('3 steps · 1m 5s');
  });

  it('detail levels: Summary shows no faded steps while live; Full opens everything with commands and diffs', () => {
    const now = Date.now() / 1000;
    const live = groupOf([tool('Bash', '$ Build', 'ok', null, now), tool('Bash', '$ Test', 'running', null, now)], null);
    expect(host(render(live, true, 'summary'), 'work-recent')).toHaveLength(0);
    expect(host(render(live, true, 'steps'), 'work-recent')).toHaveLength(1);
    const full = render(groupOf(DONE.map((x) => ({ ...x }))), false, 'full');
    expect(steps(full)).toHaveLength(2);
    expect(texts(full)).toContain('Bash: $ Find the placeholder'); // commands open
    expect(host(full, 'work-inline-diff')).toHaveLength(1);
    expect(texts(full)).toContain('+new');
    expect(texts(full)).not.toContain('+++ b/'); // the absolute-path headers are gone
  });

  it('a file row opens the full-screen diff: short path in the header, wrapped lines, no a/ b/ headers', () => {
    const r = render(groupOf(DONE.map((x) => ({ ...x }))));
    act(() => head(r).props.onPress());
    act(() => r.root.findAll((x) => x.props.testID === 'work-file-a.ts' && typeof x.props.onPress === 'function')[0]!.props.onPress());
    const screen = host(r, 'diff-screen')[0]!;
    const lines = screen.findAllByType(Text).map(own);
    expect(lines).toContain('a.ts');
    expect(lines).toContain('app/src/a.ts');
    expect(lines.some((l) => l.includes('/home/ubuntu'))).toBe(false);
    // Wrapped: no line is clipped to one line.
    expect(screen.findAllByType(Text).every((t) => t.props.numberOfLines === undefined || t.props.numberOfLines === 1)).toBe(true);
    act(() => screen.findAll((x) => x.props.accessibilityLabel === 'Close' && typeof x.props.onPress === 'function')[0]!.props.onPress());
    expect(host(r, 'diff-screen')).toHaveLength(0);
  });
});
