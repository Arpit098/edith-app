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
    for (const part of ['Now', 'Running Bash · 2 queued', '$ npm test', 'Connected', 'Lanes', 'Session', 'Agents', 'Running Bash · 0:42', '321k tokens', 'edith-dev', 'needs approval', 'Live p1-live-7']) {
      expect(shown).toContain(part);
    }
    expect(shown).not.toContain('Retry now');

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
