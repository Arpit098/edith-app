// The switch: TalkBack's "switch" with its state, a 48 dp touch target, the accent track filling as it
// turns on, a spring that "Remove animations" skips, and a drawn-only form for rows that are the switch.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';

import { GlassContext, type GlassSettings } from '../../core/theme';
import { Toggle, TOUCH } from '../Toggle';

jest.setTimeout(30_000); // the first run transforms React Native

const settings = (reduceMotion: boolean): GlassSettings => ({ mode: 'flat', View: null, reduceMotion });

function render(node: React.ReactElement, reduceMotion = false) {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<GlassContext.Provider value={settings(reduceMotion)}>{node}</GlassContext.Provider>);
  });
  return r;
}

const switchOf = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.accessibilityRole === 'switch' && typeof n.props.onPress === 'function');
const fillOpacity = (r: ReactTestRenderer) => {
  const fill = r.root.findAll((n) => n.props.testID === 'toggle-fill')[0]!;
  return StyleSheet.flatten(fill.props.style).opacity;
};

describe('Toggle', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is a switch for TalkBack, with its label and state, and flips on press', () => {
    const changes: boolean[] = [];
    const r = render(<Toggle value={false} onChange={(on) => changes.push(on)} label="Push" />);
    const [sw] = switchOf(r);
    expect(sw!.props.accessibilityLabel).toBe('Push');
    expect(sw!.props.accessibilityState).toEqual({ checked: false, disabled: false });
    act(() => sw!.props.onPress());
    expect(changes).toEqual([true]);
    act(() => r.update(<GlassContext.Provider value={settings(false)}><Toggle value onChange={(on) => changes.push(on)} label="Push" /></GlassContext.Provider>));
    expect(switchOf(r)[0]!.props.accessibilityState).toEqual({ checked: true, disabled: false });
    act(() => switchOf(r)[0]!.props.onPress());
    expect(changes).toEqual([true, false]);
  });

  it('has at least a 48 dp touch target', () => {
    const r = render(<Toggle value={false} onChange={() => {}} label="x" />);
    const style = StyleSheet.flatten(switchOf(r)[0]!.props.style);
    expect(style.minWidth).toBeGreaterThanOrEqual(48);
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(TOUCH).toBe(48);
  });

  it('fills the track with the accent as it turns on', () => {
    const r = render(<Toggle value={false} onChange={() => {}} label="x" />);
    expect(fillOpacity(r)).toBe(0);
    const on = render(<Toggle value onChange={() => {}} label="x" />);
    expect(fillOpacity(on)).toBe(1);
  });

  it('slides with a spring, and jumps with "Remove animations" on', () => {
    const spring = jest.spyOn(Reanimated, 'withSpring');
    const r = render(<Toggle value={false} onChange={() => {}} label="x" />);
    act(() => r.update(<GlassContext.Provider value={settings(false)}><Toggle value onChange={() => {}} label="x" /></GlassContext.Provider>));
    expect(spring).toHaveBeenCalled();
    spring.mockClear();
    const still = render(<Toggle value={false} onChange={() => {}} label="x" />, true);
    act(() => still.update(<GlassContext.Provider value={settings(true)}><Toggle value onChange={() => {}} label="x" /></GlassContext.Provider>));
    expect(spring).not.toHaveBeenCalled();
  });

  it('does nothing while disabled, and says so', () => {
    const changes: boolean[] = [];
    const r = render(<Toggle value={false} disabled onChange={(on) => changes.push(on)} label="Hey Edith" />);
    const [sw] = switchOf(r);
    expect(sw!.props.disabled).toBe(true);
    expect(sw!.props.accessibilityState).toEqual({ checked: false, disabled: true });
  });

  it('inside a row that is the switch, is drawn only: no second TalkBack stop or touch target', () => {
    const r = render(<Toggle value onChange={() => {}} label="x" decorative />);
    expect(switchOf(r)).toHaveLength(0);
    expect(r.root.findAll((n) => n.props.importantForAccessibility === 'no-hide-descendants')).not.toHaveLength(0);
  });
});
