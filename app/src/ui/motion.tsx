// Liquid motion (PLAN.md §4.11): springs on the UI thread (Reanimated worklets: no JS per frame).
// With Android's "Remove animations" on (GlassSettings.reduceMotion) everything is at its end state.

import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { AppState, Pressable, type PressableProps, type StyleProp, type View, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

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
}: Omit<PressableProps, 'style' | 'children'> & { style?: StyleProp<ViewStyle>; outerStyle?: StyleProp<ViewStyle>; children?: ReactNode; ref?: Ref<View> }) {
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

/** Slides in a little from the right when it mounts: a sub-page opening (Settings → Push). */
export const SlideIn = memo(function SlideIn({ style, children }: { style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const reduce = useReduceMotion();
  const p = useSharedValue(reduce ? 1 : 0);
  useEffect(() => {
    if (!reduce) p.value = withSpring(1, motion.settle);
  }, [p, reduce]);
  const animated = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 1.5),
    transform: [{ translateX: (1 - p.value) * 32 }],
  }));
  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
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
 * A sheet that grows out of `origin` (where its trigger is) while `open`, and shrinks back into it
 * when closed. It stays mounted until the closing spring settles, then unmounts, so a closed sheet
 * costs nothing. With "Remove animations" on it appears and goes at once.
 */
export function GrowSheet({ open, origin, style, children }: { open: boolean; origin: string; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const reduce = useReduceMotion();
  const [mounted, setMounted] = useState(open);
  const p = useSharedValue(0);
  // Read when the closing spring ends: if it was opened again meanwhile, it stays mounted.
  const openNow = useRef(open);
  openNow.current = open;
  const unmountIfClosed = useCallback(() => {
    if (!openNow.current) setMounted(false);
  }, []);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      p.value = reduce ? 1 : withSpring(1, motion.grow);
    } else if (reduce) {
      p.value = 0;
      setMounted(false);
    } else {
      p.value = withSpring(0, motion.press, (finished) => {
        if (finished) scheduleOnRN(unmountIfClosed);
      });
    }
  }, [open, mounted, reduce, p, unmountIfClosed]);

  const animated = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 1.5),
    transform: [{ scale: 0.55 + 0.45 * p.value }],
  }));
  if (!mounted) return null;
  return (
    <Animated.View style={[style, { transformOrigin: origin }, animated]} pointerEvents={open ? 'auto' : 'none'}>
      {children}
    </Animated.View>
  );
}

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
