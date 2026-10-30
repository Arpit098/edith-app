// Liquid motion (PLAN.md §4.11): springs on the UI thread (Reanimated worklets: no JS per frame).
// With Android's "Remove animations" on (GlassSettings.reduceMotion) everything is at its end state.

import { memo, useEffect, useState, type ReactNode } from 'react';
import { AppState, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
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

/**
 * Settles into place from a little below on mount, when `animate` (a new message, not history or a
 * row scrolled back into view). Decided once at mount: a row that doesn't animate gets no wrapper.
 *
 * Only while EDITH is on screen: the spring runs on the UI thread's frames, which stop in the
 * background, and a row left part-way stays transparent (a reply that came in during a call was
 * there, selectable, but invisible). So a row that mounts in the background doesn't animate, and
 * one still settling when the app leaves or comes back drops its wrapper and shows as it is.
 */
export function SettleIn({ animate, children }: { animate: boolean; children: ReactNode }) {
  const reduce = useReduceMotion();
  const [run, setRun] = useState(() => animate && !reduce && AppState.currentState === 'active');
  useEffect(() => {
    if (!run) return;
    const sub = AppState.addEventListener('change', () => setRun(false));
    return () => sub.remove();
  }, [run]);
  return run ? <Settling>{children}</Settling> : <>{children}</>;
}

function Settling({ children }: { children: ReactNode }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withSpring(1, motion.settle);
  }, [p]);
  const animated = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 2),
    transform: [{ translateY: (1 - p.value) * 18 }, { scale: 0.96 + 0.04 * p.value }],
  }));
  return <Animated.View style={animated}>{children}</Animated.View>;
}
