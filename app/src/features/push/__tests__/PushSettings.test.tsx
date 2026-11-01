import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';

import { createStore } from '../../../core/store';
import type { PushModel, PushState } from '../model';
import { pushToggle, pushToggleState, PushSettings } from '../PushSettings';

jest.setTimeout(30_000); // the first run transforms React Native

const OFF: PushState['status'] = { enabled: false, ntfyUrl: null, mode: 'instant', connected: false, error: null, lastCheckAt: null, batteryUnrestricted: false };

function fakeModel() {
  const store = createStore<PushState>({ status: OFF, error: null, fetching: false });
  const calls = { turnOn: [] as (string | undefined)[], enabled: [] as [string, string, string | undefined][], modes: [] as string[], disabled: 0, battery: 0 };
  const model: PushModel = {
    store,
    turnOn: async (mode) => {
      calls.turnOn.push(mode);
      store.set({ status: { ...OFF, enabled: true, ntfyUrl: 'http://edith:2586', mode: mode ?? 'instant' }, error: null, fetching: false });
      return true;
    },
    enable: (url, token, mode) => {
      calls.enabled.push([url, token, mode]);
      store.set({ status: { ...OFF, enabled: true, ntfyUrl: url, mode: mode ?? 'instant' }, error: null, fetching: false });
      return true;
    },
    setMode: (mode) => {
      calls.modes.push(mode);
      store.set((s) => ({ ...s, status: { ...s.status, mode } }));
    },
    disable: () => void calls.disabled++,
    refresh: () => {},
    openBatterySettings: () => void calls.battery++,
    dispose: () => {},
  };
  return { model, store, calls };
}

const texts = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).join(''))
    .join(' | ');
const press = (r: ReactTestRenderer, label: string) => r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]!.props.onPress();
const input = (r: ReactTestRenderer, label: string) => r.root.findAllByType(TextInput).find((n) => n.props.accessibilityLabel === label)!;

describe('PushSettings', () => {
  const mounted: ReactTestRenderer[] = [];
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {})); // react-test-renderer is deprecated in React 19
  afterEach(() => act(() => mounted.splice(0).forEach((r) => r.unmount())));

  it('turns on with nothing to paste, then shows the state and the battery hint', async () => {
    const { model, store, calls } = fakeModel();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<PushSettings model={model} defaultUrl="http://edith:2586" />);
    });
    mounted.push(r);
    expect(r.root.findAllByType(TextInput)).toHaveLength(0); // the manual fields wait under Advanced
    await act(async () => press(r, 'Turn on'));
    expect(calls.turnOn).toEqual(['instant']);
    expect(calls.enabled).toEqual([]);
    expect(texts(r)).toContain('connecting');
    expect(texts(r)).toContain('Battery to Unrestricted');
    act(() => press(r, 'Open app info'));
    expect(calls.battery).toBe(1);
    act(() => store.set((s) => ({ ...s, status: { ...s.status, connected: true, batteryUnrestricted: true } })));
    expect(texts(r)).toContain('connected to edith');
    expect(texts(r)).not.toContain('Unrestricted');
    const toggle = r.root.find((n) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === 'Push' && typeof n.props.onPress === 'function');
    expect(toggle.props.accessibilityState).toMatchObject({ checked: true });
    act(() => toggle.props.onPress()); // the big switch at the top turns it off
    expect(calls.disabled).toBe(1);
  });

  it('turns on from the switch at the top too, in the mode picked, and shows the modes as segments', async () => {
    const { model, calls } = fakeModel();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<PushSettings model={model} defaultUrl="http://edith:2586" />);
    });
    mounted.push(r);
    const radios = r.root.findAll((n) => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function');
    expect(radios.map((n) => [n.props.accessibilityLabel, n.props.accessibilityState.checked])).toEqual([
      ['Instant', true],
      ['Every 15 min', false],
    ]);
    act(() => press(r, 'Every 15 min'));
    const toggle = r.root.find((n) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === 'Push' && typeof n.props.onPress === 'function');
    expect(toggle.props.accessibilityState).toMatchObject({ checked: false });
    await act(async () => toggle.props.onPress());
    expect(calls.turnOn).toEqual(['poll']);
  });

  it('wires the Settings list’s switch: on asks edith in the mode last used, off forgets the token', () => {
    const { model, store, calls } = fakeModel();
    const toggle = (s: PushState) => pushToggle(model, pushToggleState(s));
    const off = toggle(store.get());
    expect(off).toMatchObject({ on: false, disabled: false, detail: null });
    off.set(true);
    expect(calls.turnOn).toEqual(['instant']);
    store.set((s) => ({ ...s, status: { ...s.status, enabled: true, mode: 'poll' } }));
    const on = toggle(store.get());
    expect(on).toMatchObject({ on: true, detail: 'Every 15 min' });
    on.set(false);
    expect(calls.disabled).toBe(1);
    expect(toggle({ ...store.get(), fetching: true }).disabled).toBe(true); // no double tap while edith is asked
  });

  it('keeps the row’s summary beside the list’s switch, without the “On” the switch says', () => {
    const { model, store } = fakeModel();
    const detail = (status: Partial<PushState['status']>, error: string | null = null) => pushToggle(model, pushToggleState({ status: { ...store.get().status, ...status }, error, fetching: false })).detail;
    expect(detail({ enabled: true, mode: 'instant', connected: true })).toBe('Instant');
    expect(detail({ enabled: true, mode: 'instant', connected: false })).toBe('Instant · connecting');
    expect(detail({ enabled: true, mode: 'instant', connected: false, error: 'refused' })).toBe('Instant · not reaching edith');
    expect(detail({ enabled: true, mode: 'poll', connected: false })).toBe('Every 15 min');
    expect(detail({ enabled: false })).toBeNull();
    expect(detail({ enabled: false }, 'That isn’t an ntfy token')).toBe('Couldn’t turn on'); // a refused turn-on isn't silent
  });

  it('gives the list a stable slice: a poll’s last-check time doesn’t make a new one', () => {
    const { store } = fakeModel();
    store.set((s) => ({ ...s, status: { ...s.status, enabled: true, mode: 'poll', connected: true } }));
    const a = pushToggleState(store.get());
    store.set((s) => ({ ...s, status: { ...s.status, lastCheckAt: 123 } }));
    expect(pushToggleState(store.get())).toBe(a);
  });

  it('turns on in the 15-minute mode: no battery hint, the last check shown', async () => {
    const { model, store, calls } = fakeModel();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<PushSettings model={model} defaultUrl="http://edith:2586" />);
    });
    mounted.push(r);
    act(() => press(r, 'Every 15 min'));
    expect(texts(r)).toContain('less battery');
    await act(async () => press(r, 'Turn on'));
    expect(calls.turnOn).toEqual(['poll']);
    expect(texts(r)).toContain('first check comes within 15 minutes');
    expect(texts(r)).not.toContain('Unrestricted');
    act(() => store.set((s) => ({ ...s, status: { ...s.status, connected: true, lastCheckAt: Date.UTC(2026, 9, 30, 3, 35) } })));
    expect(texts(r)).toContain('Last check 09:05 IST'); // IST whatever the phone's zone
    act(() => press(r, 'Instant'));
    expect(calls.modes).toEqual(['instant']);
    expect(texts(r)).toContain('Battery to Unrestricted');
  });

  it('keeps entering the token by hand under Advanced, with placeholders that read as empty', () => {
    const { model, calls } = fakeModel();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<PushSettings model={model} defaultUrl="http://edith:2586" />);
    });
    mounted.push(r);
    // A row with its own chevron icon: TalkBack reaches it by its visible words, and hears it open.
    const advanced = () => r.root.find((n) => n.props.accessibilityLabel === 'Enter the token by hand' && typeof n.props.onAccessibilityAction === 'function');
    expect(advanced().props.accessibilityState).toMatchObject({ expanded: false });
    act(() => advanced().props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
    expect(advanced().props.accessibilityState).toMatchObject({ expanded: true });
    expect(input(r, 'Push server').props.value).toBe('http://edith:2586');
    for (const label of ['Push server', 'Phone token']) {
      const placeholder: string = input(r, label).props.placeholder;
      expect(placeholder).not.toMatch(/https?:|tk_|~\/|\d/); // words, never something that looks entered
    }
    expect(input(r, 'Phone token').props.secureTextEntry).toBe(true);
    act(() => input(r, 'Phone token').props.onChangeText('tk_x'));
    act(() => press(r, 'Turn on with this token'));
    expect(calls.enabled).toEqual([['http://edith:2586', 'tk_x', 'instant']]);
    expect(calls.turnOn).toEqual([]);
  });

  it('shows the Turn on button busy while edith is asked', () => {
    const { model, store } = fakeModel();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<PushSettings model={model} defaultUrl="" />);
    });
    mounted.push(r);
    act(() => store.set((s) => ({ ...s, fetching: true })));
    const button = r.root.findAll((n) => n.props.accessibilityLabel === 'Turn on' && n.props.accessibilityState)[0]!;
    expect(button.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  });

  it('shows why a setup was refused', () => {
    const { model, store } = fakeModel();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<PushSettings model={model} defaultUrl="" />);
    });
    mounted.push(r);
    act(() => store.set((s) => ({ ...s, error: 'That isn’t an ntfy token' })));
    expect(texts(r)).toContain('That isn’t an ntfy token');
  });
});
