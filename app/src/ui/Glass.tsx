// A Liquid Glass surface (PLAN.md §4.11): translucent grey, a light edge catching light from the
// top-left, and a soft inner highlight along the top. Over a backdrop (useBackdrop) and where the
// shell allows it, it's real glass: the native view (edith-glass) bends and blurs what's behind
// it ('shader', Android 13+) or blurs it ('blur', Android 12). Everywhere else, and on surfaces
// without a backdrop (cards in lists), it's the flat fallback: same look, no cost.

import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useState, type ReactNode } from 'react';
import { findNodeHandle, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { glass, glassTint, radius as radii, useGlass, type GlassLevel } from '../core/theme';

export interface GlassProps {
  level?: GlassLevel;
  /** The React tag of the view behind (from useBackdrop); without it the surface is flat. */
  backdrop?: number | null;
  radius?: number;
  /** Which sides draw the light edge (a bar flush with the screen edge skips that side). */
  edges?: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

const ALL = { top: true, bottom: true, left: true, right: true };

/** A view to put glass over: attach `ref` to it (it must not contain that glass). */
export function useBackdrop(): { ref: (v: View | null) => void; tag: number | null } {
  const [tag, setTag] = useState<number | null>(null);
  const ref = useCallback((v: View | null) => setTag(v ? findNodeHandle(v) : null), []);
  return { ref, tag };
}

export const Glass = memo(function Glass({ level = 'regular', backdrop, radius = radii.l, edges = ALL, style, children }: GlassProps) {
  const g = glass[level];
  const { mode, View: Native } = useGlass();
  const real = mode !== 'flat' && Native !== null && backdrop != null;
  const [lit, dim] = g.edge;
  return (
    <View
      style={[
        styles.base,
        {
          borderRadius: radius,
          backgroundColor: real ? 'transparent' : g.flat, // real glass draws its own tint
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
      {real ? (
        <Native
          backdrop={backdrop}
          mode={mode}
          cornerRadius={radius}
          blur={g.blur}
          refraction={g.refraction}
          bezel={g.bezel}
          dispersion={g.dispersion}
          saturation={g.saturation}
          specular={g.specular}
          tint={glassTint[level]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : null}
      <LinearGradient colors={[g.highlight, 'transparent']} style={styles.highlight} pointerEvents="none" />
      {children}
    </View>
  );
});

const styles = StyleSheet.create({
  base: { overflow: 'hidden' },
  highlight: { position: 'absolute', top: 0, left: 0, right: 0, height: 28 },
});
