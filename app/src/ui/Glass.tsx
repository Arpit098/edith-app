// A Liquid Glass surface (PLAN.md §4.11): translucent grey, a light edge catching light from the
// top-left, and a soft inner highlight along the top. It blurs what's behind it only when the shell
// allows it (Android 12+, not in battery saver) AND gives it a blur target, which the shell does for
// a few big surfaces only (header, tab bar). Everywhere else it's the flat fallback: same look, no
// blur, so lists keep 60 fps.

import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, type ReactNode, type RefObject } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { glass, radius as radii, useGlass, type GlassLevel } from '../core/theme';

export interface GlassProps {
  level?: GlassLevel;
  /** The BlurTargetView behind this surface; without it the surface is flat. */
  blurTarget?: RefObject<View | null>;
  radius?: number;
  /** Which sides draw the light edge (a bar flush with the screen edge skips that side). */
  edges?: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

const ALL = { top: true, bottom: true, left: true, right: true };

export const Glass = memo(function Glass({ level = 'regular', blurTarget, radius = radii.l, edges = ALL, style, children }: GlassProps) {
  const g = glass[level];
  const { blur } = useGlass();
  const blurring = blur && !!blurTarget;
  const [lit, dim] = g.edge;
  return (
    <View
      style={[
        styles.base,
        {
          borderRadius: radius,
          backgroundColor: blurring ? 'transparent' : g.flat, // blurring: the tint goes over the blur below
          borderTopWidth: edges.top ? StyleSheet.hairlineWidth : 0,
          borderLeftWidth: edges.left ? StyleSheet.hairlineWidth : 0,
          borderRightWidth: edges.right ? StyleSheet.hairlineWidth : 0,
          borderBottomWidth: edges.bottom ? StyleSheet.hairlineWidth : 0,
          borderTopColor: lit,
          borderLeftColor: lit,
          borderRightColor: dim,
          borderBottomColor: dim,
        },
        style,
      ]}
    >
      {blurring ? (
        <BlurView
          blurTarget={blurTarget}
          blurMethod="dimezisBlurViewSdk31Plus" // RenderEffect blur on Android 12+; translucent below
          intensity={g.blur}
          tint="dark"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : null}
      {blurring ? <View style={[StyleSheet.absoluteFill, { backgroundColor: g.tint }]} pointerEvents="none" /> : null}
      <LinearGradient colors={[g.highlight, 'transparent']} style={styles.highlight} pointerEvents="none" />
      {children}
    </View>
  );
});

const styles = StyleSheet.create({
  base: { overflow: 'hidden' },
  highlight: { position: 'absolute', top: 0, left: 0, right: 0, height: 28 },
});
