// Settings → Voice input (a switch row) and Settings → Chat → Work details (a segmented choice).

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { createStore } from '../../../core/store';
import { ChatSettings } from '../ChatSettings';
import { createWorkDetailSetting } from '../chatSettings';
import { VoiceSettings } from '../VoiceSettings';
import type { VoiceModel, VoiceState } from '../voice';

jest.setTimeout(30_000); // the first run transforms React Native

const texts = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).join(''))
    .join(' | ');

describe('settings pages of the live session', () => {
  const mounted: ReactTestRenderer[] = [];
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {})); // react-test-renderer is deprecated in React 19
  afterEach(() => act(() => mounted.splice(0).forEach((r) => r.unmount())));

  it('Voice input: the whole row is the switch, read with its state', async () => {
    const store = createStore<VoiceState>({ available: true, phase: 'idle', elapsedMs: 0, level: 0, error: null, autoSend: false });
    const set: boolean[] = [];
    const voice = { store, setAutoSend: async (on: boolean) => void (set.push(on), store.set((s) => ({ ...s, autoSend: on }))) } as unknown as VoiceModel;
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<VoiceSettings voice={voice} />);
    });
    mounted.push(r);
    const sw = () => r.root.findAll((n) => n.props.accessibilityRole === 'switch' && typeof n.props.onPress === 'function');
    expect(sw()).toHaveLength(1); // one TalkBack stop: the row, not the row and its drawn switch
    expect(sw()[0]!.props.accessibilityLabel).toBe('Send right after speaking');
    expect(sw()[0]!.props.accessibilityState).toMatchObject({ checked: false });
    expect(texts(r)).toContain('goes into the box first');
    await act(async () => sw()[0]!.props.onPress());
    expect(set).toEqual([true]);
    expect(sw()[0]!.props.accessibilityState).toMatchObject({ checked: true });
    expect(texts(r)).toContain('sends what you said straight away');
  });

  it('Chat: Work details is a segmented choice with what it means under it', () => {
    const saved: [string, unknown][] = [];
    const setting = createWorkDetailSetting({ get: async () => null, set: async (k: string, v: unknown) => void saved.push([k, v]) } as never);
    let r!: ReactTestRenderer;
    act(() => {
      r = create(<ChatSettings setting={setting} />);
    });
    mounted.push(r);
    const radios = () => r.root.findAll((n) => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function');
    expect(radios().map((n) => [n.props.accessibilityLabel, n.props.accessibilityState.checked])).toEqual([
      ['Summary', false],
      ['Steps', true],
      ['Full', false],
    ]);
    expect(texts(r)).toContain('A failed step always shows');
    act(() => radios()[2]!.props.onPress());
    expect(setting.store.get()).toBe('full');
    expect(saved).toHaveLength(1);
    expect(texts(r)).toContain('Every step and edit, open');
    expect(texts(r)).toContain('Work details: Full');
  });
});
