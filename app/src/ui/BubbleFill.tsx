// A gradient bubble's tint (Settings → Appearance → Bubbles): one gradient view laid inside the
// bubble's border, in its rounded shape, so the bubble itself needs no clipping. Nothing at all for a
// one-colour bubble (the bubble's own background is its tint), so the plain case costs no extra view.

import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet } from 'react-native';

import { radius, type BubbleLook } from '../core/theme';

const BORDER = 1; // the bubble's edge: the fill sits inside it

/** `tail`: the bubble's small corner (bottom-right for mine, bottom-left for EDITH's). */
export const BubbleFill = memo(function BubbleFill({ look, tail }: { look: BubbleLook; tail: 'right' | 'left' }) {
  if (!look.gradient) return null;
  const big = radius.l - BORDER;
  const small = radius.s - BORDER;
  return (
    <LinearGradient
      colors={look.gradient.colors}
      start={look.gradient.start}
      end={look.gradient.end}
      pointerEvents="none"
      testID="bubble-fill"
      style={[
        StyleSheet.absoluteFill,
        { borderTopLeftRadius: big, borderTopRightRadius: big, borderBottomLeftRadius: tail === 'left' ? small : big, borderBottomRightRadius: tail === 'right' ? small : big },
      ]}
    />
  );
});
