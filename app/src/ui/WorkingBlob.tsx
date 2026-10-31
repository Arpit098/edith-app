// The working indicator (PLAN.md §4.11): a small glass blob that breathes and changes shape. A
// UI-thread loop (no JS per frame), cancelled on unmount; still under "Remove animations".

import { memo, useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { glass, motion, themedStyles } from '../core/theme';
import { useReduceMotion } from './motion';

const TAU = Math.PI * 2;

/** Corners and scale move on different phases of one cycle, so the outline never repeats a simple pulse. */
export const WorkingBlob = memo(function WorkingBlob() {
  const reduce = useReduceMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    if (reduce) return;
    t.value = withRepeat(withTiming(1, { duration: motion.blobMs, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [t, reduce]);
  const shape = useAnimatedStyle(() => {
    const a = t.value * TAU;
    return {
      borderTopLeftRadius: 9 + 3 * Math.sin(a),
      borderTopRightRadius: 9 + 3 * Math.sin(a + 1.6),
      borderBottomRightRadius: 9 + 3 * Math.sin(a + 3.2),
      borderBottomLeftRadius: 9 + 3 * Math.sin(a + 4.8),
      transform: [{ scaleX: 1 + 0.14 * Math.sin(a) }, { scaleY: 1 - 0.12 * Math.sin(a + 0.9) }, { rotate: `${10 * Math.sin(a / 2)}deg` }],
    };
  });
  const styles = useStyles();
  return <Animated.View style={[styles.blob, shape]} />;
});

const useStyles = themedStyles((t) =>
  StyleSheet.create({
    blob: {
      width: 20,
      height: 16,
      borderRadius: 9,
      backgroundColor: t.accentSoft,
      borderWidth: StyleSheet.hairlineWidth,
      borderTopColor: glass.thin.edge[0],
      borderLeftColor: glass.thin.edge[0],
      borderRightColor: t.accent,
      borderBottomColor: t.accent,
    },
  }),
);
