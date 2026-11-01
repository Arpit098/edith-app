// Settings → Wake word: the big switch (only with a model installed), the sensitivity with its value,
// the training pill, and the Settings list's switch.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { EventBus } from '../../../core/events';
import { createStore } from '../../../core/store';
import type { WakewordModel, WakewordState } from '../model';
import { WakeWordSettings, wakewordToggle } from '../WakeWordSettings';

jest.setTimeout(30_000); // the first run transforms React Native

function fake(installed: boolean) {
  const store = createStore({ enabled: false, installed: installed ? { version: 'v3' } : null, sensitivity: 0.5, clips: [] } as unknown as WakewordState);
  const calls = { enabled: [] as boolean[], sensitivity: [] as number[] };
  const model = {
    store,
    setEnabled: async (on: boolean) => {
      calls.enabled.push(on);
      store.set((s) => ({ ...s, enabled: on }));
    },
    setSensitivity: (v: number) => void calls.sensitivity.push(v),
  } as unknown as WakewordModel;
  return { model, store, calls };
}

const texts = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).join(''))
    .join(' | ');
const toggle = (r: ReactTestRenderer) => r.root.find((n) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === 'Hey Edith' && typeof n.props.onPress === 'function');

describe('WakeWordSettings', () => {
  const mounted: ReactTestRenderer[] = [];
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {})); // react-test-renderer is deprecated in React 19
  afterEach(() => act(() => mounted.splice(0).forEach((r) => r.unmount())));

  it('switches “Hey Edith” from the top card and shows the sensitivity’s value', async () => {
    const { model, calls } = fake(true);
    const bus = new EventBus();
    const opened: unknown[] = [];
    bus.on('app.open', (e) => void opened.push(e.data), 'test');
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<WakeWordSettings model={model} bus={bus} />);
    });
    mounted.push(r);
    expect(toggle(r).props.accessibilityState).toMatchObject({ checked: false, disabled: false });
    await act(async () => toggle(r).props.onPress());
    expect(calls.enabled).toEqual([true]);
    expect(toggle(r).props.accessibilityState).toMatchObject({ checked: true });
    expect(texts(r)).toContain('Sensitivity');
    expect(texts(r)).toContain('50%');
    act(() => r.root.find((n) => n.props.accessibilityLabel === 'Train wake word' && typeof n.props.onPress === 'function').props.onPress());
    expect(opened).toEqual([{ screen: 'wakeword' }]);
  });

  it('keeps the switch off until a model is trained', () => {
    const { model } = fake(false);
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<WakeWordSettings model={model} bus={new EventBus()} />);
    });
    mounted.push(r);
    expect(toggle(r).props.accessibilityState).toMatchObject({ checked: false, disabled: true });
    expect(texts(r)).toContain('Train a model first');
  });

  it('wires the Settings list’s switch', () => {
    const { model, calls } = fake(true);
    const t = wakewordToggle(model, { enabled: false, installed: { version: 'v3' } });
    expect(t).toMatchObject({ on: false, disabled: false });
    t.set(true);
    expect(calls.enabled).toEqual([true]);
    expect(wakewordToggle(model, { enabled: false, installed: null }).disabled).toBe(true);
  });
});
