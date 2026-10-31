// A Liquid Glass surface (PLAN.md §4.11): translucent grey, a light edge catching light from the
// top-left, and a soft inner highlight along the top. Over a backdrop (useBackdrop) and where the
// shell allows it, it's real glass: the native view (edith-glass) bends and blurs what's behind
// it ('shader', Android 13+) or blurs it ('blur', Android 12). Everywhere else, and on surfaces
// without a backdrop (cards in lists), it's the flat fallback: same look, no cost.
// Popups (the panel level) are one clear glass view like the rest: no scrim or second blurred pane;
// their labels carry a dark halo instead (theme legibleText).
// With `rim`, the hairline edge gives way to the specular rim (ui/Rim.tsx): a gradient stroke bright
// at the top-left and bottom-right, an inner highlight and a faint inner shadow.

import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useState, type ReactNode } from 'react';
import { findNodeHandle, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { glassOn, radius as radii, rgbaOf, useGlass, useTheme, type GlassLevel, type GlassStyle } from '../core/theme';
import { Rim } from './Rim';

// The native view takes colours as numbers: parsed once per theme and level.
const parsed = new WeakMap<GlassStyle, number[]>();
const tintOf = (g: GlassStyle) => {
  let v = parsed.get(g);
  if (!v) parsed.set(g, (v = rgbaOf(g.tint)));
  return v;
};
const bases = new Map<string, number[]>();
const baseOf = (bg: string) => {
  let v = bases.get(bg);
  if (!v) bases.set(bg, (v = rgbaOf(bg)));
  return v;
};

export interface GlassProps {
  level?: GlassLevel;
  /** The React tag of the view behind (from useBackdrop); without it the surface is flat. */
  backdrop?: number | null;
  radius?: number;
  /** Which sides draw the light edge (a bar flush with the screen edge skips that side). */
  edges?: { top?: boolean; bottom?: boolean; left?: boolean; right?: boolean };
  /**
   * The specular rim instead of the hairline edge (`edges` is then ignored): light catching the
   * glass, bright at the top-left and bottom-right, in the scheme's colours (GlassSettings.scheme).
   */
  rim?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}

const ALL = { top: true, bottom: true, left: true, right: true };
const NONE: NonNullable<GlassProps['edges']> = {};

/** A view to put glass over: attach `ref` to it (it must not contain that glass). */
export function useBackdrop(): { ref: (v: View | null) => void; tag: number | null } {
  const [tag, setTag] = useState<number | null>(null);
  const ref = useCallback((v: View | null) => setTag(v ? tagOf(v) : null), []);
  return { ref, tag };
}

/** The view's native tag; null where there is none (react-native-web throws): the glass is then flat. */
function tagOf(v: View): number | null {
  try {
    return findNodeHandle(v);
  } catch {
    return null;
  }
}

interface Size {
  width: number;
  height: number;
}

export const Glass = memo(function Glass({ level = 'regular', backdrop, radius = radii.l, edges = ALL, rim = false, style, children }: GlassProps) {
  const theme = useTheme();
  const g = theme.glassOf(level); // the glass amount (Settings → Appearance) mapped for this level
  const { mode, View: Native, scheme } = useGlass();
  // 0% is the flat look everywhere: no blur or lens to draw (the cheapest and most readable).
  const real = mode !== 'flat' && Native !== null && backdrop != null && glassOn(theme.glass);
  const [lit, dim] = g.edge;
  const line = rim ? NONE : edges;
  // The rim needs the surface's size; a move (the keyboard opening) keeps the same object, so no re-render.
  const [size, setSize] = useState<Size | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
  }, []);
  return (
    <View
      onLayout={rim ? onLayout : undefined}
      style={[
        styles.base,
        {
          borderRadius: radius,
          backgroundColor: real ? 'transparent' : g.flat, // real glass draws its own tint
          borderTopWidth: line.top ? StyleSheet.hairlineWidth : 0,
          borderLeftWidth: line.left ? StyleSheet.hairlineWidth : 0,
          borderRightWidth: line.right ? StyleSheet.hairlineWidth : 0,
          borderBottomWidth: line.bottom ? StyleSheet.hairlineWidth : 0,
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
          lift={g.lift}
          specular={rim ? 0 : g.specular} // the rim is the edge's light: no second line from the lens
          rimWidth={g.rimWidth}
          tint={tintOf(g)}
          base={baseOf(theme.bg)}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : null}
      <LinearGradient colors={[g.highlight, 'transparent']} style={styles.highlight} pointerEvents="none" />
      {children}
      {rim && size ? <Rim width={size.width} height={size.height} radius={radius} scheme={scheme} strength={theme.rim} /> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  base: { overflow: 'hidden' },
  highlight: { position: 'absolute', top: 0, left: 0, right: 0, height: 28 },
});
