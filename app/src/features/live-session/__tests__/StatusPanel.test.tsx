// The header chip from store state (dot, bubble, the turn's timer) and the card it drops: opens on
// tap, fetches only while open, every 10 s, and offers a retry or Settings when the link is down.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { statusDetailsFrom } from '../../../core/api';
import type { Connection } from '../../../core/connection';
import { createStore } from '../../../core/store';
import { GlassContext } from '../../../core/theme';
import { ev, fakeContext } from '../../../testing/fakes';
import { initialLive, reduce, type LiveModel } from '../model';
import { StatusChip, StatusPopup } from '../StatusPanel';
import { mainRun, trackTurnStart } from '../status';
import { DETAILS } from './details';

jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

function texts(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).filter((c) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

function chip(r: ReactTestRenderer): ReactTestInstance {
  return r.root.findAll((n) => n.props?.accessibilityState?.expanded !== undefined && typeof n.props.onPress === 'function')[0]!;
}

/** The thinking bubble's `active` (it moves only while EDITH thinks or runs a tool). */
function bubbleActive(r: ReactTestRenderer): boolean {
  return r.root.findAll((n) => typeof n.props?.active === 'boolean' && typeof n.props?.size === 'number')[0]!.props.active;
}

/** The card's summary, read as one by a screen reader: state, time, detail. */
function summaryLabel(r: ReactTestRenderer): string {
  return r.root.findAll((n) => n.props?.accessible === true && typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('EDITH, '))[0]!.props.accessibilityLabel;
}

function toggle(r: ReactTestRenderer) {
  chip(r).props.onPress();
}

function press(r: ReactTestRenderer, label: string) {
  r.root.findAll((n) => n.props?.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]!.props.onPress();
}

function fakeVisibility() {
  let active = true;
  const handlers = new Set<(a: boolean) => void>();
  return {
    active: () => active,
    onChange(h: (a: boolean) => void) {
      handlers.add(h);
      return () => handlers.delete(h);
    },
    set(a: boolean) {
      active = a;
      handlers.forEach((h) => h(a));
    },
  };
}

function fakes() {
  const store = createStore(initialLive);
  trackTurnStart(store); // what createLiveModel does: one shared turn start
  const details = jest.fn().mockResolvedValue(statusDetailsFrom(DETAILS));
  const visibility = fakeVisibility();
  const connection = fakeContext().connection;
  connection.store.set({ link: 'open', baseUrl: 'http://edith:8787', error: null, retryInMs: null });
  const open = createStore(false);
  const onSettings = jest.fn();
  return { model: { store, details, visibility } as unknown as LiveModel, store, details, visibility, connection, open, onSettings };
}

async function mount(f: ReturnType<typeof fakes>): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <GlassContext.Provider value={{ mode: 'flat', View: null, reduceMotion: true }}>
        <StatusChip model={f.model} connection={f.connection as Connection} open={f.open} />
        <StatusPopup model={f.model} connection={f.connection as Connection} open={f.open} top={60} backdrop={null} onSettings={f.onSettings} />
      </GlassContext.Provider>,
    );
  });
  return r;
}

describe('StatusChip and StatusPopup', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  });
  afterEach(() => jest.useRealTimers());

  it('is a still bubble with no timer when idle; works with a moving bubble and the turn time; opens and closes the card', async () => {
    const f = fakes();
    const r = await mount(f);
    expect(bubbleActive(r)).toBe(false);
    expect(texts(r)).toBe(''); // idle: no timer, nothing else
    expect(chip(r).props.accessibilityLabel).toBe('Connected. EDITH: Idle. Show details');
    expect(f.details).not.toHaveBeenCalled(); // closed: nothing fetched

    await act(async () => {
      f.store.set((s) =>
        [
          ev('session.changed', { session_id: 's1', title: 'disk check', source: 'resume' }),
          ev('turn.started', { ref: 'r1', lane: 'main' }),
          ev('tool.call', { id: 't1', name: 'Bash', summary: '$ npm test' }),
          ev('lane.status', { main: 'busy', side: 0, queued: 2 }),
        ].reduce(reduce, s),
      );
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(bubbleActive(r)).toBe(true);
    expect(texts(r)).toMatch(/^0:0[34]$/);
    expect(chip(r).props.accessibilityLabel).toBe('Connected. EDITH: Running Bash, 2 queued. Show details');

    // A progress event with the server's elapsed time: the whole turn so far, not since the app saw it.
    await act(async () => {
      f.store.set((s) => reduce(s, ev('turn.progress', { ref: 'r1', lane: 'main', steps: 1, step: '$ npm test', elapsed: 40 })));
    });
    expect(texts(r)).toMatch(/^0:40$/);

    await act(async () => toggle(r));
    expect(f.details).toHaveBeenCalledTimes(1);
    const shown = texts(r);
    // The summary, then the sections: friendly values, agents with a state chip and their last action.
    for (const part of [
      'Running Bash', '$ npm test', '2 queued', '1:40', // the turn's time from the server: began 100 s before its answer
      'Lanes', 'check the disk · 0:12', '1 of 2 running', '2 messages', '1 waiting',
      'Session', 'Phase 2 app', '157', '321k of 1M',
      'Agents', 'edith-dev', 'Busy', 'release-notes', 'Running the tests', 'Needs approval',
      'Server', 'Connected', 'p1-live-7', '14h 13m',
    ]) {
      expect(shown).toContain(part);
    }
    expect(shown).not.toContain('Retry now');
    expect(shown).not.toContain('tokens'); // a known window: "321k of 1M", not a bare count
    expect(r.root.findAll((n) => n.props?.accessibilityRole === 'progressbar' && n.props.accessibilityLabel === 'Context 32% full, 321k of 1M' && n.props.accessibilityValue?.now === 32)).not.toHaveLength(0); // the thin bar

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(f.details).toHaveBeenCalledTimes(2);

    await act(async () => toggle(r));
    expect(texts(r)).not.toContain('Agents');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(f.details).toHaveBeenCalledTimes(2); // closed: no more fetches

    await act(async () => {
      f.store.set((s) => [ev('turn.done', { ref: 'r1', lane: 'main', text: 'ok' }), ev('lane.status', { main: 'idle', side: 0, queued: 0 })].reduce(reduce, s));
    });
    expect(bubbleActive(r)).toBe(false);
    expect(texts(r)).toBe(''); // idle again: the timer goes
    act(() => r.unmount());
  });

  it('waiting for approval: the timer runs, the bubble holds still', async () => {
    const f = fakes();
    const r = await mount(f);
    await act(async () => {
      f.store.set((s) => [ev('turn.started', { ref: 'r1', lane: 'main' }), ev('permission.request', { id: 'p1', tool: 'Bash', detail: 'rm', ref: 'r1', lane: 'main' })].reduce(reduce, s));
    });
    expect(bubbleActive(r)).toBe(false);
    expect(texts(r)).toMatch(/^0:0\d$/);
    act(() => r.unmount());
  });

  it('reply done, background work running: calm (still bubble, no timer, "1 bg"); the card lists the work', async () => {
    const f = fakes();
    f.details.mockResolvedValue(statusDetailsFrom({ ...DETAILS, edith: { ...DETAILS.edith, state: 'waiting', tool: null, step: null, ref: null, since: 990 } }));
    const r = await mount(f);
    await act(async () => {
      f.store.set((s) =>
        [
          ev('turn.started', { ref: 'r1', lane: 'main' }),
          ev('background.changed', { jobs: [{ id: 'tu1', kind: 'shell', label: 'Wait for PR 41 CI', started: 820 }] }),
          ev('turn.done', { ref: 'r1', lane: 'main', text: 'Watching it' }),
        ].reduce(reduce, s),
      );
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(bubbleActive(r)).toBe(false);
    expect(texts(r)).toBe('1 bg'); // no turn timer
    expect(chip(r).props.accessibilityLabel).toBe('Connected. EDITH: Waiting on background work, 1 bg. Show details');

    await act(async () => toggle(r));
    const shown = texts(r);
    // The card's summary (no turn timer), its Background section, and the waiting agent's chip.
    for (const part of ['Waiting on background work', '1 bg · for 10s', 'Background', 'Shell · Wait for PR 41 CI · 3 min', 'edith-ci',
      'Waiting · bg shell']) {
      expect(shown).toContain(part);
    }
    act(() => r.unmount());
  });

  it('stops fetching in the background and refreshes on return', async () => {
    const f = fakes();
    const r = await mount(f);
    await act(async () => toggle(r));
    expect(f.details).toHaveBeenCalledTimes(1);
    await act(async () => f.visibility.set(false));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(f.details).toHaveBeenCalledTimes(1); // backgrounded: nothing
    await act(async () => f.visibility.set(true));
    expect(f.details).toHaveBeenCalledTimes(2); // back on screen: at once
    act(() => r.unmount());
  });

  it('leaves out empty rows when idle, and says how long EDITH has been idle', async () => {
    const f = fakes();
    const idle = {
      ...DETAILS,
      edith: { state: 'idle', tool: null, step: null, since: 1000 - 720, ref: null, turn_started: null, tmux: 'running' },
      lanes: { side: [], max_side: 2, queued: 0, approvals: 0 },
      session: { ...DETAILS.session, started: 1000 - 180, messages: 0, context_tokens: 120_000 },
      agents: [],
    };
    f.details.mockResolvedValue(statusDetailsFrom(idle));
    const r = await mount(f);
    await act(async () => toggle(r));
    const shown = texts(r);
    for (const part of ['Idle', 'for 12m', 'Only the main lane, nothing waiting', '3 min ago', '120k of 200k', 'No coding agents running']) expect(shown).toContain(part);
    for (const gone of ['Queued', 'Approvals', 'Side lanes', 'Messages', 'Parallel']) expect(shown).not.toContain(gone);
    act(() => r.unmount());
  });

  it('the card times the turn from the same start as the chip, though it opens later (no elapsed yet), and restarts on a new run', async () => {
    const f = fakes();
    f.details.mockResolvedValue(statusDetailsFrom({ ...DETAILS, edith: { ...DETAILS.edith, state: 'thinking', ref: 'old', turn_started: 500 } }));
    const r = await mount(f);
    // Busy before any run is seen: no run, so no elapsed at all (run.elapsed null).
    await act(async () => f.store.set((s) => reduce(s, ev('lane.status', { main: 'busy', side: 0, queued: 0 }))));
    expect(mainRun(f.store.get()).elapsed).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    // The run appears (no elapsed carried yet): a fresh start for both.
    await act(async () => f.store.set((s) => reduce(s, ev('turn.started', { ref: 'r1', lane: 'main' }))));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(25_000);
    });
    await act(async () => toggle(r)); // GrowSheet mounts the card only now
    expect(texts(r)).toMatch(/^0:25 \| /); // the chip
    // The card: the shared start, not the moment it opened, and not the server's start for another run.
    expect(summaryLabel(r)).toMatch(/^EDITH, Thinking, for 0:25/);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    expect(summaryLabel(r)).toMatch(/for 0:30/);

    // Closed and reopened: GrowSheet remounts the card, the time carries on.
    await act(async () => toggle(r));
    await act(async () => toggle(r));
    expect(summaryLabel(r)).toMatch(/for 0:30/);

    // A new run: both start again.
    await act(async () => f.store.set((s) => [ev('turn.done', { ref: 'r1', lane: 'main', text: 'ok' }), ev('turn.started', { ref: 'r2', lane: 'main' })].reduce(reduce, s)));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(3_000);
    });
    expect(texts(r)).toMatch(/^0:0[34] \| /);
    expect(summaryLabel(r)).toMatch(/for 0:0[34]/);
    act(() => r.unmount());
  });

  it("uses the server's turn start only for the run the stream shows", async () => {
    const f = fakes();
    // DETAILS: ts 1000, the main run r1 started at 900: 1:40 in.
    const r = await mount(f);
    await act(async () => f.store.set((s) => reduce(s, ev('turn.started', { ref: 'r1', lane: 'main' }))));
    await act(async () => toggle(r));
    expect(summaryLabel(r)).toMatch(/for 1:40/);
    act(() => r.unmount());
  });

  it('keeps relative times running between fetches, and forgets the details when closed', async () => {
    const f = fakes();
    f.details.mockResolvedValue(statusDetailsFrom({ ...DETAILS, edith: { ...DETAILS.edith, state: 'idle', ref: null, since: 990 }, session: { ...DETAILS.session, started: 990 } }));
    const r = await mount(f);
    await act(async () => toggle(r));
    expect(texts(r)).toContain('Started | just now');
    expect(texts(r)).toContain('check the disk · 0:12');
    expect(summaryLabel(r)).toContain('for 10s');
    f.details.mockRejectedValue(new Error('unreachable')); // every later poll fails: nothing new to render
    await act(async () => {
      await jest.advanceTimersByTimeAsync(130_000);
    });
    expect(texts(r)).toContain('Started | 2 min ago');
    expect(texts(r)).toContain('check the disk · 2:22');
    expect(summaryLabel(r)).toContain('for 2m');

    await act(async () => toggle(r));
    f.details.mockReturnValue(new Promise(() => {})); // the next answer never comes
    await act(async () => toggle(r));
    expect(texts(r)).toContain('Loading…'); // not the old answer
    expect(texts(r)).not.toContain('Started');
    act(() => r.unmount());
  });

  it('shows a load error in the card', async () => {
    const f = fakes();
    f.details.mockRejectedValue(new Error('unreachable'));
    const r = await mount(f);
    await act(async () => toggle(r));
    expect(texts(r)).toContain("Couldn't load the details: unreachable");
    act(() => r.unmount());
  });

  it('offers a retry when offline and Settings when the token is rejected', async () => {
    const f = fakes();
    const retry = jest.spyOn(f.connection, 'retry').mockImplementation(() => {});
    const r = await mount(f);
    await act(async () => f.connection.store.set({ link: 'offline', baseUrl: 'http://edith:8787', error: 'timed out', retryInMs: 5000 }));
    expect(chip(r).props.accessibilityLabel).toMatch(/^Offline \(timed out\) · retrying in 5s\. EDITH: Idle/);
    await act(async () => toggle(r));
    expect(texts(r)).toContain('Offline (timed out) · retrying in 5s');
    await act(async () => press(r, 'Retry now'));
    expect(retry).toHaveBeenCalled();

    await act(async () => f.connection.store.set({ link: 'unauthorized', baseUrl: 'http://edith:8787', error: null, retryInMs: null }));
    await act(async () => press(r, 'Open Settings'));
    expect(f.onSettings).toHaveBeenCalled();
    act(() => r.unmount());
  });
});
