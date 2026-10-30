// Liquid motion (PLAN.md §4.11): springs on the UI thread (Reanimated worklets: no JS per frame).
// With Android's "Remove animations" on (GlassSettings.reduceMotion) everything is at its end state.

import { memo, useEffect, type ReactNode } from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { motion, useGlass } from '../core/theme';

export function useReduceMotion(): boolean {
  return useGlass().reduceMotion;
}

/** A Pressable that squishes a little while pressed and springs back. */
export const Squish = memo(function Squish({
  style,
  outerStyle,
  children,
  onPressIn,
  onPressOut,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & { style?: StyleProp<ViewStyle>; outerStyle?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const reduce = useReduceMotion();
  const scale = useSharedValue(1);
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      {...rest}
      style={outerStyle}
      onPressIn={(e) => {
        if (!reduce) scale.value = withSpring(motion.pressScale, motion.press);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.value = reduce ? 1 : withSpring(1, motion.press);
        onPressOut?.(e);
      }}
    >
      <Animated.View style={[style, animated]}>{children}</Animated.View>
    </Pressable>
  );
});

/** Grows out of a corner (where its trigger is) when it mounts: a sheet or menu opening. */
export const GrowIn = memo(function GrowIn({ origin = 'left bottom', style, children }: { origin?: string; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const reduce = useReduceMotion();
  const p = useSharedValue(reduce ? 1 : 0);
  useEffect(() => {
    if (!reduce) p.value = withSpring(1, motion.grow);
  }, [p, reduce]);
  const animated = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 1.6),
    transform: [{ scale: 0.6 + 0.4 * p.value }],
  }));
  return <Animated.View style={[style, { transformOrigin: origin }, animated]}>{children}</Animated.View>;
});

/** Settles into place from a little below on mount, when `animate` (a new message, not history). */
export const SettleIn = memo(function SettleIn({ animate, style, children }: { animate: boolean; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const reduce = useReduceMotion();
  const run = animate && !reduce;
  const p = useSharedValue(run ? 0 : 1);
  useEffect(() => {
    if (run) p.value = withSpring(1, motion.settle);
  }, [p, run]);
  const animated = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 2),
    transform: [{ translateY: (1 - p.value) * 18 }, { scale: 0.96 + 0.04 * p.value }],
  }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
});
