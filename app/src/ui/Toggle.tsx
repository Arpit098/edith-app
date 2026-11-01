// An on/off switch (Arpit, 1 Nov: "add slider switches where you can"): the thumb slides across and
// the track fills with the theme's accent, on the UI thread (a spring; with "Remove animations" on it
// jumps). The touch target is at least 48 dp, and TalkBack reads it as a switch with its state.
// React Native's own Switch isn't used: it can't follow the theme's accent on every Android version.

import { memo, useEffect } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { colors, motion, useTheme } from '../core/theme';
import { useReduceMotion } from './motion';

export const TOUCH = 48; // the smallest touch target, dp

const SIZES = {
  regular: { w: 46, h: 28, thumb: 22 },
  large: { w: 56, h: 34, thumb: 28 },
} as const;

export interface ToggleProps {
  value: boolean;
  onChange: (on: boolean) => void;
  label: string; // what TalkBack reads with the state, e.g. "Push"
  disabled?: boolean;
  size?: keyof typeof SIZES;
  /** Inside a row that is itself the switch: drawn only, not a second TalkBack stop or touch target. */
  decorative?: boolean;
  hint?: string;
}

export const Toggle = memo(function Toggle({ value, onChange, label, disabled, size = 'regular', decorative, hint }: ToggleProps) {
  const { accent } = useTheme();
  const reduce = useReduceMotion();
  const s = SIZES[size];
  const pad = (s.h - s.thumb) / 2;
  const travel = s.w - s.thumb - 2 * pad;
  const p = useSharedValue(value ? 1 : 0);
  useEffect(() => {
    p.value = reduce ? (value ? 1 : 0) : withSpring(value ? 1 : 0, motion.press);
  }, [p, value, reduce]);
  const fill = useAnimatedStyle(() => ({ opacity: p.value }));
  const thumb = useAnimatedStyle(() => ({ transform: [{ translateX: p.value * travel }] }));

  const track = (
    <View style={[styles.track, { width: s.w, height: s.h, borderRadius: s.h / 2, opacity: disabled ? 0.45 : 1 }]} testID="toggle-track">
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: accent, borderRadius: s.h / 2 }, fill]} testID="toggle-fill" />
      <Animated.View style={[styles.thumb, { width: s.thumb, height: s.thumb, borderRadius: s.thumb / 2, top: pad, left: pad }, thumb]} />
    </View>
  );
  if (decorative) {
    return (
      <View style={styles.target} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {track}
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      style={styles.target}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ checked: value, disabled: !!disabled }}
    >
      {track}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  target: { minWidth: TOUCH, minHeight: TOUCH, alignItems: 'center', justifyContent: 'center' },
  track: { backgroundColor: colors.hairline, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, overflow: 'hidden' },
  thumb: { position: 'absolute', backgroundColor: colors.text },
});
