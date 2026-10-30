import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text, TextInput } from 'react-native';

import { createStore } from '../../../core/store';
import type { PushModel, PushState } from '../model';
import { PushSettings } from '../PushSettings';

jest.setTimeout(30_000); // the first run transforms React Native

const OFF: PushState['status'] = { enabled: false, ntfyUrl: null, mode: 'instant', connected: false, error: null, lastCheckAt: null, batteryUnrestricted: false };

function fakeModel() {
  const store = createStore<PushState>({ status: OFF, error: null });
  const calls = { enabled: [] as [string, string, string | undefined][], modes: [] as string[], disabled: 0, battery: 0 };
  const model: PushModel = {
    store,
    enable: (url, token, mode) => {
      calls.enabled.push([url, token, mode]);
      store.set({ status: { ...OFF, enabled: true, ntfyUrl: url, mode: mode ?? 'instant' }, error: null });
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

  it('turns on with the address and token entered, then shows the state and the battery hint', () => {
    const { model, store, calls } = fakeModel();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<PushSettings model={model} defaultUrl="http://edith:2586" />);
    });
    mounted.push(r);
    expect(input(r, 'Push server').props.value).toBe('http://edith:2586');
    act(() => input(r, 'Phone token').props.onChangeText('tk_x'));
    act(() => press(r, 'Turn on'));
    expect(calls.enabled).toEqual([['http://edith:2586', 'tk_x', 'instant']]);
    expect(texts(r)).toContain('connecting');
    expect(texts(r)).toContain('Battery to Unrestricted');
    act(() => press(r, 'Open app info'));
    expect(calls.battery).toBe(1);
    act(() => store.set((s) => ({ ...s, status: { ...s.status, connected: true, batteryUnrestricted: true } })));
    expect(texts(r)).toContain('connected to edith');
    expect(texts(r)).not.toContain('Unrestricted');
    act(() => press(r, 'Turn off'));
    expect(calls.disabled).toBe(1);
  });

  it('turns on in the 15-minute mode: no battery hint, the last check shown', () => {
    const { model, store, calls } = fakeModel();
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<PushSettings model={model} defaultUrl="http://edith:2586" />);
    });
    mounted.push(r);
    act(() => press(r, 'Every 15 min'));
    expect(texts(r)).toContain('less battery');
    act(() => input(r, 'Phone token').props.onChangeText('tk_x'));
    act(() => press(r, 'Turn on'));
    expect(calls.enabled).toEqual([['http://edith:2586', 'tk_x', 'poll']]);
    expect(texts(r)).toContain('first check comes within 15 minutes');
    expect(texts(r)).not.toContain('Unrestricted');
    act(() => store.set((s) => ({ ...s, status: { ...s.status, connected: true, lastCheckAt: new Date(2026, 9, 30, 9, 5).getTime() } })));
    expect(texts(r)).toContain('Last check 09:05');
    act(() => press(r, 'Instant'));
    expect(calls.modes).toEqual(['instant']);
    expect(texts(r)).toContain('Battery to Unrestricted');
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
