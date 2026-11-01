// A bottom sheet with two rest positions, open and closed, that slides (never resizes: its height is
// fixed, so what's inside doesn't move when its content changes). It springs to `open` on the UI
// thread (reanimated), or jumps there with "Remove animations"; the view given `handle` (the
// handlers its content spreads on its header) drags it, and on release
// `snap(progress, velocity)` says where it rests (progress 0 closed .. 1 open, velocity in sheet
// heights a second, up positive), then `onSettle` reports the drag to the owner of `open`.

import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { PanResponder, type GestureResponderHandlers, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { motion } from '../core/theme';
import { useReduceMotion } from './motion';

const SPRING = motion.grow;
const SLOP = 4; // px a touch moves before it's a drag (a tap on the handle's buttons stays a tap)

export interface SnapSheetProps {
  open: boolean;
  height: number;
  /** Extra distance it travels when closed, past its height (e.g. a margin under it). */
  hiddenOffset?: number;
  snap: (progress: number, velocity: number) => boolean;
  onSettle: (progress: number, velocity: number) => void;
  /** The content; spread `handle` on the part that drags the sheet (its header). */
  children: (handle: GestureResponderHandlers) => ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SnapSheet({ open, height, hiddenOffset = 0, snap, onSettle, children, style, testID }: SnapSheetProps) {
  const reduce = useReduceMotion();
  const p = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    const target = open ? 1 : 0;
    p.value = reduce ? target : withSpring(target, SPRING);
  }, [open, reduce, p]);

  const latest = useRef({ from: 0, height, reduce, snap, onSettle });
  latest.current = { ...latest.current, height, reduce, snap, onSettle };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > SLOP,
        onPanResponderGrant: () => {
          latest.current.from = p.value;
        },
        onPanResponderMove: (_e, g) => {
          const l = latest.current;
          p.value = Math.min(1, Math.max(0, l.from - g.dy / Math.max(1, l.height)));
        },
        onPanResponderRelease: (_e, g) => {
          const l = latest.current;
          const progress = p.value;
          const velocity = (-g.vy * 1000) / Math.max(1, l.height);
          const target = l.snap(progress, velocity) ? 1 : 0;
          p.value = l.reduce ? target : withSpring(target, SPRING); // back to rest even if `open` stays the same
          l.onSettle(progress, velocity);
        },
        onPanResponderTerminationRequest: () => false,
      }),
    [p],
  );
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - p.value) * (height + hiddenOffset) }] }));
  return (
    <Animated.View
      style={[{ height }, style, slide]}
      pointerEvents={open ? 'auto' : 'box-none'}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!open}
      testID={testID}
    >
      {children(responder.panHandlers)}
    </Animated.View>
  );
}
