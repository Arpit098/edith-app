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
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, findNodeHandle, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';

import { glassEdge, glassOn, INK_LIGHT, radius as radii, rgbaOf, useGlass, useTheme, type BubbleLook, type GlassLevel, type GlassStyle } from '../core/theme';
import { Rim, type Corners } from './Rim';

// The native view takes colours as numbers: parsed once per theme and level.
const parsed = new WeakMap<GlassStyle, number[]>();
const tintOf = (g: GlassStyle) => {
  let v = parsed.get(g);
  if (!v) parsed.set(g, (v = rgbaOf(g.tint)));
  return v;
};
const edges = new WeakMap<GlassStyle, string>();
/** The light edge as one colour (core/theme glassEdge), once per style. */
const edgeOf = (g: GlassStyle) => {
  let v = edges.get(g);
  if (!v) edges.set(g, (v = glassEdge(g)));
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
  const line = rim ? NONE : edges;
  // A closed outline in one colour: Android splits per-side colours on each corner's diagonal, so a
  // lit top-left and dim bottom-right edge broke off at the other two corners. A bar (one side) keeps its own.
  const closed = !!(line.top && line.left && line.right && line.bottom);
  const [lit, dim] = closed ? [edgeOf(g), edgeOf(g)] : g.edge;
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

/**
 * The wallpaper alone (ui/Ambient, in its own view): what a chat bubble's lens looks through. The
 * native view can't sample a backdrop that contains it, and the transcript contains the bubbles, so
 * the shell (and the Appearance preview) gives the bubbles the view under them instead: the photo,
 * gradient or pattern. Null where there's none: bubbles are then flat, as before.
 */
export const WallpaperContext = createContext<number | null>(null);

const NO_TINT = [0, 0, 0, 0];
export const BUBBLE_BORDER = 1; // the bubble's edge width (live-session and the preview draw it)

/** A bubble's corners: all large but the tail's (bottom-right for mine, bottom-left for EDITH's). */
export function bubbleCorners(tail: 'right' | 'left'): Corners {
  return { tl: radii.l, tr: radii.l, br: tail === 'right' ? radii.s : radii.l, bl: tail === 'left' ? radii.s : radii.l };
}

/** Whether a bubble draws liquid glass here (BubbleLens): the bubble then hides its own edge, the rim replaces it. */
export function useLiquid(look: BubbleLook): boolean {
  const theme = useTheme();
  const wallpaper = useContext(WallpaperContext);
  const { mode, View: Native } = useGlass();
  return mode !== 'flat' && Native !== null && wallpaper !== null && theme.lens !== null && look.ink === INK_LIGHT;
}

/**
 * A see-through chat bubble's liquid glass, laid first in the bubble (under BubbleFill and the
 * text), over its whole box (its edge included: the bubble hides its border when this draws).
 * - Android 13+: a light blur of the wallpaper, then the lens (theme `lens`): a thin band at the
 *   rounded edge bends it, eased from nothing at the band's inner side to the most at the edge (the
 *   shader squares it), so the bend has no step where it ends.
 * - Android 12 has no shader: the blur alone.
 * - Both: the edge light is ui/Rim's (not the shader's one-radius line): a thin stroke on the
 *   bubble's exact outline, the small tail corner included, fading smoothly from the lit top-left,
 *   with its inner glow and inner shadow. The lens's shape is one radius, the large one: at the
 *   tail it lies inside the outline (never past it, so nothing needs clipping), and that corner's
 *   last few dp show the tint over the wallpaper unbent (per-corner lens radii need a native change).
 * Nothing at 0% glass, in battery saver or before Android 12, with "reduce transparency", without
 * a wallpaper view, or where the bubble's ink is dark (useLiquid): the bubble is its flat tint then.
 *
 * Readability: inside it's the bubble's tint over the blurred, bent wallpaper, with no saturation
 * boost or lift; a blurred or bent pixel is a mix of the wallpaper's own colours, and white text
 * on a mix is never worse off than on the brightest of them (luminance is convex), which is what the
 * theme's 4.5:1 checks use. The rim stays inside the bubble's padding, away from the text.
 */
/**
 * How visible the bubbles' glass is, 0..1, on the native driver (the transcript provides it): it
 * fades out while the list moves, so no bubble re-blurs the wallpaper every scroll frame, and back in
 * when it stops. The glass view stays mounted, props untouched (no effect rebuilt, no shader
 * compiled): at opacity 0 the renderer skips drawing it. Null: always shown (the preview).
 */
export const GlassFadeContext = createContext<Animated.Value | null>(null);
export const GLASS_FADE_MS = 150;

/** `inside`: the bubble shows its own edge now (a ring: failed, a quote's target), so the glass sits inside it, without a rim. */
export const BubbleLens = memo(function BubbleLens({ look, tail, inside = false }: { look: BubbleLook; tail: 'right' | 'left'; inside?: boolean }) {
  const theme = useTheme();
  const wallpaper = useContext(WallpaperContext);
  const fade = useContext(GlassFadeContext);
  const { mode, View: Native, scheme, reduceMotion } = useGlass();
  const lens = theme.lens;
  const liquid = useLiquid(look);
  const [size, setSize] = useState<Size | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
  }, []);
  // A bubble given glass while in view (a new message) fades it in rather than popping.
  const appear = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  useEffect(() => {
    if (liquid) Animated.timing(appear, { toValue: 1, duration: reduceMotion ? 0 : GLASS_FADE_MS, useNativeDriver: true }).start();
  }, [liquid, appear, reduceMotion]);
  const opacity = useMemo(() => (fade ? Animated.multiply(fade, appear) : appear), [fade, appear]);
  if (!liquid || !Native || !lens || wallpaper === null) return null;
  const shader = mode === 'shader';
  const inset = inside ? BUBBLE_BORDER : 0;
  return (
    <View style={inside ? StyleSheet.absoluteFill : styles.bubbleBox} onLayout={inside ? undefined : onLayout} pointerEvents="none" testID="bubble-lens">
      <Animated.View style={[StyleSheet.absoluteFill, { opacity }]} pointerEvents="none">
        <Native
          backdrop={wallpaper}
          mode={mode === 'shader' ? 'shader' : 'blur'}
          cornerRadius={radii.l - inset}
          blur={lens.blur}
          refraction={shader ? lens.refraction : 0}
          bezel={lens.bezel}
          dispersion={0} // no colour split: inside is only mixes of the wallpaper's colours (the contrast argument)
          saturation={1}
          lift={0}
          specular={0} // the rim (below) is the edge light, on the exact outline
          rimWidth={lens.rimWidth}
          tint={look.gradient ? NO_TINT : tintOfCss(look.fill)} // a gradient's tint is BubbleFill's, over this
          base={baseOf(theme.bg)}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      </Animated.View>
      {/* The rim stays while the glass fades: the bubble keeps its edge mid-scroll. */}
      {size && !inside ? <Rim width={size.width} height={size.height} radius={radii.l} corners={bubbleCorners(tail)} scheme={scheme} strength={theme.rim} /> : null}
    </View>
  );
});

const tints = new Map<string, number[]>();
const tintOfCss = (css: string) => {
  let v = tints.get(css);
  if (!v) {
    if (tints.size > 64) tints.clear(); // bounded: every theme change makes new fills
    tints.set(css, (v = rgbaOf(css)));
  }
  return v;
};

const styles = StyleSheet.create({
  base: { overflow: 'hidden' },
  highlight: { position: 'absolute', top: 0, left: 0, right: 0, height: 28 },
  // Over the bubble's border box (an absolute child sits inside the border): the lens and rim reach its edge.
  bubbleBox: { position: 'absolute', top: -BUBBLE_BORDER, left: -BUBBLE_BORDER, right: -BUBBLE_BORDER, bottom: -BUBBLE_BORDER },
});
