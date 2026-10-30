import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import type { AppVisibility, OngoingStatus } from '../../../core/ports';
import { LiveAlertsSettings } from '../LiveAlertsSettings';

jest.setTimeout(30_000); // the first run transforms React Native

function fakeStatus(liveUpdates: boolean) {
  const calls = { opened: 0, tested: 0 };
  let allowed = false;
  const status: OngoingStatus = {
    show() {},
    clear() {},
    ensurePermission: async () => true,
    canPromote: () => allowed,
    openPromotionSettings: () => void calls.opened++,
    liveUpdates,
    testIsland: () => void calls.tested++,
  };
  return { status, calls, allow: () => (allowed = true) };
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

describe('LiveAlertsSettings', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {})); // react-test-renderer is deprecated in React 19

  it('shows the banner while Live Updates are off, opens the switch, and clears once it is on', () => {
    const { status, calls, allow } = fakeStatus(true);
    const { visibility, set } = fakeVisibility();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<LiveAlertsSettings status={status} visibility={visibility} />);
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
      r = create(<LiveAlertsSettings status={status} />);
    });
    expect(texts(r)).not.toContain('Live Updates are off');
    expect(texts(r)).toContain('Live Alerts need Android 16');
  });
});
