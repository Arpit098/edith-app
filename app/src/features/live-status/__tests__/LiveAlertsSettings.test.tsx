import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import type { AppVisibility, OngoingStatus } from '../../../core/ports';
import { LiveAlertsSettings } from '../LiveAlertsSettings';

jest.setTimeout(30_000); // the first run transforms React Native

function fakeStatus(liveUpdates: boolean) {
  const calls = { opened: 0, tested: 0 };
  let demo: () => { ok: boolean; message: string } = () => ({ ok: true, message: 'Demo running for 30 s' });
  let allowed = false;
  const status: OngoingStatus = {
    show() {},
    clear() {},
    ensurePermission: async () => true,
    canPromote: () => allowed,
    openPromotionSettings: () => void calls.opened++,
    liveUpdates,
    testIsland: () => {
      calls.tested++;
      return demo();
    },
  };
  return { status, calls, allow: () => (allowed = true), demoAnswers: (f: typeof demo) => (demo = f) };
}

function fakeVisibility() {
  const handlers = new Set<(active: boolean) => void>();
  const visibility: AppVisibility = {
    active: () => true,
    onChange: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
  return { visibility, set: (active: boolean) => handlers.forEach((h) => h(active)) };
}

const texts = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).join(''))
    .join(' | ');
const press = (r: ReactTestRenderer, label: string) => r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]!.props.onPress();

const mounted: ReactTestRenderer[] = [];
const mount = (el: Parameters<typeof create>[0]) => {
  const r = create(el);
  mounted.push(r);
  return r;
};

describe('LiveAlertsSettings', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {})); // react-test-renderer is deprecated in React 19
  // Unmount each tree: a mounted icon would keep loading after Jest tears the environment down.
  afterEach(() => act(() => mounted.splice(0).forEach((r) => r.unmount())));

  it('shows the banner while Live Updates are off, opens the switch, and clears once it is on', () => {
    const { status, calls, allow } = fakeStatus(true);
    const { visibility, set } = fakeVisibility();
    let r!: ReactTestRenderer;
    act(() => {
      r = mount(<LiveAlertsSettings status={status} visibility={visibility} />);
    });
    expect(texts(r)).toContain('Live Updates are off for EDITH');
    act(() => press(r, 'Turn on Live Updates'));
    expect(calls.opened).toBe(1);
    allow(); // Arpit turned it on in Android's settings
    act(() => set(true)); // and came back
    expect(texts(r)).not.toContain('Live Updates are off');
    act(() => press(r, 'Test island'));
    expect(calls.tested).toBe(1);
  });

  it('shows no banner before Android 16, where there is nothing to turn on', () => {
    const { status } = fakeStatus(false);
    let r!: ReactTestRenderer;
    act(() => {
      r = mount(<LiveAlertsSettings status={status} />);
    });
    expect(texts(r)).not.toContain('Live Updates are off');
    expect(texts(r)).toContain('Live Alerts need Android 16');
  });

  it('says what the demo did, clears it after 30 s, and shows the real error when it fails', () => {
    jest.useFakeTimers();
    try {
      const { status, demoAnswers } = fakeStatus(true);
      let r!: ReactTestRenderer;
      act(() => {
        r = mount(<LiveAlertsSettings status={status} />);
      });
      act(() => press(r, 'Test island'));
      expect(texts(r)).toContain('Demo running for 30 s');
      act(() => jest.advanceTimersByTime(30_000));
      expect(texts(r)).not.toContain('Demo running');
      demoAnswers(() => ({ ok: false, message: 'Notifications are off for EDITH.' }));
      act(() => press(r, 'Test island'));
      expect(texts(r)).toContain('Notifications are off for EDITH.');
      demoAnswers(() => {
        throw new Error('native gone');
      });
      act(() => press(r, 'Test island'));
      expect(texts(r)).toContain('Couldn’t run the demo: native gone');
    } finally {
      jest.useRealTimers();
    }
  });
});
