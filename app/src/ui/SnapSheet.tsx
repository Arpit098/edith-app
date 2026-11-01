// A bottom sheet with two rest positions, open and closed, that slides (never resizes: its height is
// fixed, so what's inside doesn't move when its content changes). It springs to `open` on the UI
// thread (reanimated), or jumps there with "Remove animations". Closed, a `peek` strip of its top
// stays in view (its grab bar), so it can be dragged open. The view given `handle` (the handlers its
// content spreads on its header) drags it; on release, or when the system takes the touch away,
// `snap(progress, velocity)` says where it rests (progress 0 closed .. 1 open, velocity in sheet
// heights a second, up positive), then `onSettle` reports the drag to the owner of `open`.
//
// Touches: open, everything; while it slides closed, nothing (a tap mustn't land on a control on its
// way out); closed, only what the content leaves on (its handle: the content gets `open` to turn
// the rest off).

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { PanResponder, type GestureResponderHandlers, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { motion } from '../core/theme';
import { useReduceMotion } from './motion';

const SPRING = motion.grow;
const SLOP = 4; // px a touch moves before it's a drag (a tap on the handle's buttons stays a tap)

export interface SnapSheetProps {
  open: boolean;
  height: number;
  /** How much of its top stays in view when closed (0: none). */
  peek?: number;
  snap: (progress: number, velocity: number) => boolean;
  onSettle: (progress: number, velocity: number) => void;
  /** The content: spread `handle` on the part that drags the sheet (its header); `open` as given. */
  children: (handle: GestureResponderHandlers, open: boolean) => ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SnapSheet({ open, height, peek = 0, snap, onSettle, children, style, testID }: SnapSheetProps) {
  const reduce = useReduceMotion();
  const p = useSharedValue(open ? 1 : 0);
  const [closing, setClosing] = useState(false); // sliding closed: no touches until it's there
  const settle = useRef(() => setClosing(false)).current;

  const animate = (target: number, done: boolean) => {
    if (reduce || done) {
      p.value = target;
      return;
    }
    if (target === 0) setClosing(true);
    p.value = withSpring(target, SPRING, (finished) => {
      if (finished && target === 0) scheduleOnRN(settle);
    });
  };
  const animateRef = useRef(animate);
  animateRef.current = animate;
  useEffect(() => {
    animateRef.current(open ? 1 : 0, false);
    if (open) setClosing(false);
  }, [open, reduce]);

  const latest = useRef({ from: 0, height, snap, onSettle });
  latest.current = { ...latest.current, height, snap, onSettle };
  const responder = useMemo(() => {
    const release = (_e: unknown, g: { vy: number }) => {
      const l = latest.current;
      const progress = p.value;
      const velocity = (-g.vy * 1000) / Math.max(1, l.height);
      animateRef.current(l.snap(progress, velocity) ? 1 : 0, false); // back to rest even if `open` stays the same
      l.onSettle(progress, velocity);
    };
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > SLOP,
      onPanResponderGrant: () => {
        latest.current.from = p.value;
      },
      onPanResponderMove: (_e, g) => {
        const l = latest.current;
        p.value = Math.min(1, Math.max(0, l.from - g.dy / Math.max(1, l.height - peek)));
      },
      onPanResponderRelease: release,
      onPanResponderTerminate: release, // the system took the touch (a scroll, a call): settle all the same
      onPanResponderTerminationRequest: () => false,
    });
  }, [p, peek]);
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - p.value) * (height - peek) }] }));
  return (
    <Animated.View
      style={[{ height }, style, slide]}
      pointerEvents={closing ? 'none' : open ? 'auto' : 'box-none'}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}
      accessibilityElementsHidden={!open}
      testID={testID}
    >
      {children(responder.panHandlers, open)}
    </Animated.View>
  );
}
