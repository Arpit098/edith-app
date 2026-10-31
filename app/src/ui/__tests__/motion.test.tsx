// Liquid motion: only new things animate, nothing does under "Remove animations", presses still work.

import { act, create } from 'react-test-renderer';
import { AppState, Text, type AppStateStatus } from 'react-native';
import Animated from 'react-native-reanimated';

import { GlassContext, type GlassSettings } from '../../core/theme';
import { GrowSheet, SettleIn, Squish } from '../motion';
import { WorkingBlob } from '../WorkingBlob';

const settings = (reduceMotion: boolean): GlassSettings => ({ mode: 'flat', View: null, reduceMotion });

function render(node: React.ReactElement, reduceMotion = false) {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReturnType<typeof create>;
  act(() => {
    r = create(<GlassContext.Provider value={settings(reduceMotion)}>{node}</GlassContext.Provider>);
  });
  return r;
}

describe('SettleIn', () => {
  const appState = AppState as { currentState: string };
  const was = appState.currentState;
  beforeEach(() => {
    appState.currentState = 'active'; // EDITH on screen
  });
  afterEach(() => {
    appState.currentState = was;
    jest.restoreAllMocks();
  });

  it('wraps a new message in an animated view', () => {
    const r = render(
      <SettleIn animate>
        <Text>hi</Text>
      </SettleIn>,
    );
    expect(r.root.findAllByType(Animated.View)).toHaveLength(1);
  });

  it('adds no wrapper for history, or under Remove animations', () => {
    for (const [animate, reduce] of [
      [false, false],
      [true, true],
    ] as const) {
      const r = render(
        <SettleIn animate={animate}>
          <Text>hi</Text>
        </SettleIn>,
        reduce,
      );
      expect(r.root.findAllByType(Animated.View)).toHaveLength(0);
      expect(r.root.findByType(Text).props.children).toBe('hi');
    }
  });

  // A reply that came in while EDITH was in the background (Arpit on a call) mounted at opacity 0 and
  // its spring never ran: the row was there, selectable, but invisible.
  describe('in the background', () => {
    it("doesn't animate a message that arrives while the app is in the background", () => {
      appState.currentState = 'background';
      const r = render(
        <SettleIn animate>
          <Text>reply</Text>
        </SettleIn>,
      );
      expect(r.root.findAllByType(Animated.View)).toHaveLength(0);
      expect(r.root.findByType(Text).props.children).toBe('reply');
    });

    it('shows a message still settling as it is once the app leaves or comes back', () => {
      const listeners: ((s: AppStateStatus) => void)[] = [];
      const remove = jest.fn();
      jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, fn) => {
        listeners.push(fn);
        return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
      });
      const r = render(
        <SettleIn animate>
          <Text>reply</Text>
        </SettleIn>,
      );
      expect(r.root.findAllByType(Animated.View)).toHaveLength(1);
      act(() => listeners.forEach((fn) => fn('background')));
      expect(r.root.findAllByType(Animated.View)).toHaveLength(0);
      expect(r.root.findByType(Text).props.children).toBe('reply');
      expect(remove).toHaveBeenCalledTimes(1); // no listener left behind
    });
  });
});

describe('Squish', () => {
  it('passes presses through', () => {
    const onPress = jest.fn();
    const onPressIn = jest.fn();
    const r = render(
      <Squish onPress={onPress} onPressIn={onPressIn} accessibilityLabel="Go">
        <Text>Go</Text>
      </Squish>,
    );
    const p = r.root.find((n) => typeof n.props.onPressIn === 'function' && typeof n.props.onPressOut === 'function'); // Pressable is memo-wrapped
    act(() => {
      p.props.onPressIn({});
      p.props.onPress({});
      p.props.onPressOut({});
    });
    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('WorkingBlob', () => {
  it('renders, and unmounts cleanly (its loop is cancelled)', () => {
    const r = render(<WorkingBlob />);
    expect(r.root.findAllByType(Animated.View)).toHaveLength(1);
    act(() => r.unmount());
  });
});

describe('GrowSheet', () => {
  const sheet = (open: boolean) => (
    <GrowSheet open={open} origin="left bottom">
      <Text>menu</Text>
    </GrowSheet>
  );

  it('mounts nothing while closed', () => {
    expect(render(sheet(false)).root.findAllByType(Text)).toHaveLength(0);
  });

  it('with "Remove animations": appears and goes at once', () => {
    const r = render(sheet(true), true);
    expect(r.root.findAllByType(Text)).toHaveLength(1);
    act(() => r.update(<GlassContext.Provider value={settings(true)}>{sheet(false)}</GlassContext.Provider>));
    expect(r.root.findAllByType(Text)).toHaveLength(0);
  });

  it('grows from its trigger, and takes no touches while it shrinks', () => {
    const r = render(sheet(true));
    const view = r.root.findByType(Animated.View);
    expect(view.props.pointerEvents).toBe('auto');
    expect(JSON.stringify(view.props.style)).toContain('left bottom');
    act(() => r.update(<GlassContext.Provider value={settings(false)}>{sheet(false)}</GlassContext.Provider>));
    const closing = r.root.findAllByType(Animated.View);
    // Shrinking (still mounted, untouchable) or already gone once the spring settled.
    expect(closing.every((v) => v.props.pointerEvents === 'none')).toBe(true);
  });
});
