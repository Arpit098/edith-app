// Liquid motion: only new things animate, nothing does under "Remove animations", presses still work.

import { act, create } from 'react-test-renderer';
import { Text } from 'react-native';
import Animated from 'react-native-reanimated';

import { GlassContext, type GlassSettings } from '../../core/theme';
import { SettleIn, Squish } from '../motion';
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
