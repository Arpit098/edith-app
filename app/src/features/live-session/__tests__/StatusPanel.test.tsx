// The status bar from store state, and the card: opens on tap, fetches only while open, every 10 s.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { statusDetailsFrom } from '../../../core/api';
import { createStore } from '../../../core/store';
import { ev } from '../../../testing/fakes';
import { initialLive, reduce, type LiveModel } from '../model';
import { StatusPanel } from '../StatusPanel';
import { DETAILS } from './details';

jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

function texts(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).filter((c) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

function toggle(r: ReactTestRenderer) {
  r.root.find((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function').props.onPress();
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

function fakeModel() {
  const store = createStore(initialLive);
  const details = jest.fn().mockResolvedValue(statusDetailsFrom(DETAILS));
  const visibility = fakeVisibility();
  return { model: { store, details, visibility } as unknown as LiveModel, store, details, visibility };
}

describe('StatusPanel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  });
  afterEach(() => jest.useRealTimers());

  it('shows the state, elapsed time, counts and the step running; opens and closes the card', async () => {
    const { model, store, details } = fakeModel();
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<StatusPanel model={model} />);
    });
    expect(texts(r)).toContain('Idle');
    expect(details).not.toHaveBeenCalled(); // closed: nothing fetched

    await act(async () => {
      store.set((s) =>
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
    expect(texts(r)).toMatch(/Running Bash \|  · 0:0[34] \|/);
    expect(texts(r)).toContain(' · 2 queued');
    expect(texts(r)).toContain('$ npm test'); // the step, not the session title

    await act(async () => {
      toggle(r);
    });
    expect(details).toHaveBeenCalledTimes(1);
    const shown = texts(r);
    for (const part of ['EDITH', 'Lanes', 'Session', 'Agents', 'Running Bash · 0:42', 'check the disk', '321k tokens', 'edith-dev', 'release-notes', 'needs approval', 'Live p1-live-7']) {
      expect(shown).toContain(part);
    }
    // The bar now takes the elapsed time from the server's since (42 s at its answer).
    expect(shown).toMatch(/\|  · 0:4[23] \|/); // the bar's own clock, a text of its own

    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(details).toHaveBeenCalledTimes(2);

    await act(async () => {
      toggle(r);
    });
    expect(texts(r)).not.toContain('Agents');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(details).toHaveBeenCalledTimes(2); // closed: no more fetches
    act(() => r.unmount());
  });

  it('stops fetching in the background and refreshes on return', async () => {
    const { model, details, visibility } = fakeModel();
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<StatusPanel model={model} />);
    });
    await act(async () => {
      toggle(r);
    });
    expect(details).toHaveBeenCalledTimes(1);
    await act(async () => {
      visibility.set(false);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(details).toHaveBeenCalledTimes(1); // backgrounded: nothing
    await act(async () => {
      visibility.set(true);
    });
    expect(details).toHaveBeenCalledTimes(2); // back on screen: at once
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(details).toHaveBeenCalledTimes(3);
    act(() => r.unmount());
  });

  it('shows a load error in the card', async () => {
    const { model, details } = fakeModel();
    details.mockRejectedValue(new Error('unreachable'));
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<StatusPanel model={model} />);
    });
    await act(async () => {
      toggle(r);
    });
    expect(texts(r)).toContain("Couldn't load the details: unreachable");
    act(() => r.unmount());
  });
});
