// Themes (Settings → Appearance): Telegram-like presets that set the background, its glow and the
// accent; a colour for each side's chat bubbles; the background drawn behind everything; and how
// much glass there is (0..100%). Pure data and maths: core/theme/index.ts provides the active theme
// to the app, ui/ draws it. All presets are dark, so the neutral tokens (text, danger…) stay in
// tokens.ts; only what a theme changes is here.

import { contrast, composite, type Rgb } from './contrast';
import { colors, glass, rgbaOf, type GlassLevel, type GlassStyle } from './tokens';

export interface ThemePreset {
  id: string;
  name: string;
  bg: string; // the app's background, opaque '#rrggbb'
  glow: string; // the ambient glow's colour (top-left), opaque
  glow2: string; // the second glow (bottom-right), opaque
  glowAlpha: number; // how strong the glows are, 0..1 (0: none)
  accent: string; // opaque '#rrggbb'
}

/** Midnight is the app as it was: the logo's blue on near-black. */
export const PRESETS: readonly ThemePreset[] = [
  { id: 'midnight', name: 'Midnight', bg: '#05070A', glow: '#7CAEDC', glow2: '#7CAEDC', glowAlpha: 0.16, accent: '#7CAEDC' },
  { id: 'ocean', name: 'Ocean', bg: '#03101A', glow: '#2F9FC4', glow2: '#2E6FD6', glowAlpha: 0.2, accent: '#5CC8E8' },
  { id: 'aurora', name: 'Aurora', bg: '#060A10', glow: '#4FD6A8', glow2: '#8E6CF0', glowAlpha: 0.18, accent: '#7FE3C0' },
  { id: 'graphite', name: 'Graphite', bg: '#0C0D0F', glow: '#9AA3B2', glow2: '#6B7380', glowAlpha: 0.12, accent: '#B9C2CF' },
  { id: 'rose', name: 'Rose', bg: '#0E0709', glow: '#E07A98', glow2: '#B05AC8', glowAlpha: 0.17, accent: '#F2A0B8' },
  { id: 'forest', name: 'Forest', bg: '#050B07', glow: '#5DB070', glow2: '#2F8F7A', glowAlpha: 0.17, accent: '#8FD39C' },
  { id: 'ember', name: 'Ember', bg: '#0F0805', glow: '#E8894A', glow2: '#D0504A', glowAlpha: 0.17, accent: '#F5B070' },
  { id: 'oled', name: 'OLED black', bg: '#000000', glow: '#000000', glow2: '#000000', glowAlpha: 0, accent: '#7CAEDC' },
];

/** The bubble colours offered for each side (besides "Theme default"). */
export const SWATCHES: readonly { id: string; name: string; color: string }[] = [
  { id: 'blue', name: 'Blue', color: '#3D7FD9' },
  { id: 'sky', name: 'Sky', color: '#4FC3E8' },
  { id: 'teal', name: 'Teal', color: '#22A699' },
  { id: 'green', name: 'Green', color: '#4CAF50' },
  { id: 'yellow', name: 'Yellow', color: '#F2C94C' },
  { id: 'orange', name: 'Orange', color: '#F2994A' },
  { id: 'red', name: 'Red', color: '#E5536A' },
  { id: 'pink', name: 'Pink', color: '#E07BC4' },
  { id: 'purple', name: 'Purple', color: '#9B7CF0' },
  { id: 'grey', name: 'Grey', color: '#8A94A3' },
];

export type BackgroundId = 'glow' | 'plain' | 'sweep' | 'horizon' | 'dots' | 'grid';

/** The backgrounds: the theme's own glow, or one of these, all in the theme's colours. */
export const BACKGROUNDS: readonly { id: BackgroundId; name: string }[] = [
  { id: 'glow', name: 'Glow' }, // the theme's two soft glows (the app as it was)
  { id: 'plain', name: 'Plain' },
  { id: 'sweep', name: 'Sweep' }, // a diagonal wash from one glow colour to the other
  { id: 'horizon', name: 'Horizon' }, // a band of light across the lower half
  { id: 'dots', name: 'Dots' },
  { id: 'grid', name: 'Grid' },
];

export interface Appearance {
  theme: string; // a preset id
  myBubble: string | null; // a swatch id; null: the theme's
  edithBubble: string | null;
  background: BackgroundId;
  glass: number; // 0..100
}

export const DEFAULT_GLASS = 60; // the look the app had before the slider
export const DEFAULT_APPEARANCE: Appearance = { theme: 'midnight', myBubble: null, edithBubble: null, background: 'glow', glass: DEFAULT_GLASS };

/** A stored or partial appearance, made whole and valid (unknown ids fall back to the defaults). */
export function normalizeAppearance(v: unknown): Appearance {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const swatch = (x: unknown) => (typeof x === 'string' && SWATCHES.some((s) => s.id === x) ? x : null);
  const g = typeof o.glass === 'number' && Number.isFinite(o.glass) ? Math.round(Math.min(100, Math.max(0, o.glass))) : DEFAULT_GLASS;
  return {
    theme: typeof o.theme === 'string' && PRESETS.some((p) => p.id === o.theme) ? o.theme : DEFAULT_APPEARANCE.theme,
    myBubble: swatch(o.myBubble),
    edithBubble: swatch(o.edithBubble),
    background: BACKGROUNDS.some((b) => b.id === o.background) ? (o.background as BackgroundId) : DEFAULT_APPEARANCE.background,
    glass: g,
  };
}

// ---- colour maths ----

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** An opaque colour at an alpha, as 'rgba(…)'. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = rgbaOf(hex);
  return `rgba(${Math.round(r! * 255)}, ${Math.round(g! * 255)}, ${Math.round(b! * 255)}, ${fmt(alpha)})`;
}

export const rgbOf = (css: string): Rgb => rgbaOf(css).slice(0, 3) as unknown as Rgb;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ---- the background behind everything ----

/** One layer of a background: a linear gradient between two colours (CSS, with alpha). */
export interface BackgroundLayer {
  colors: readonly [string, string, ...string[]];
  start: { x: number; y: number };
  end: { x: number; y: number };
}

export interface BackgroundLook {
  id: BackgroundId;
  bg: string;
  layers: BackgroundLayer[];
  pattern: { kind: 'dots' | 'grid'; color: string } | null;
}

function backgroundLook(p: ThemePreset, id: BackgroundId): BackgroundLook {
  const glow = withAlpha(p.glow, p.glowAlpha);
  const glow2 = withAlpha(p.glow2, p.glowAlpha * 0.6);
  const clear = withAlpha(p.glow, 0);
  const clear2 = withAlpha(p.glow2, 0);
  const soft = (c: string, a: number) => withAlpha(c, Math.max(p.glowAlpha, 0.08) * a); // OLED: a faint pattern still
  switch (id) {
    case 'plain':
      return { id, bg: p.bg, layers: [], pattern: null };
    case 'sweep':
      return { id, bg: p.bg, layers: [{ colors: [glow, withAlpha(p.glow2, p.glowAlpha * 0.9)], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }], pattern: null };
    case 'horizon':
      return {
        id,
        bg: p.bg,
        layers: [{ colors: [clear, withAlpha(p.glow, p.glowAlpha * 1.2), withAlpha(p.glow2, p.glowAlpha * 0.5), clear2], start: { x: 0.5, y: 0.35 }, end: { x: 0.5, y: 1 } }],
        pattern: null,
      };
    case 'dots':
    case 'grid':
      return {
        id,
        bg: p.bg,
        layers: [{ colors: [glow, clear], start: { x: 0, y: 0 }, end: { x: 0.75, y: 0.55 } }],
        pattern: { kind: id, color: soft(p.glow === p.bg ? '#FFFFFF' : p.glow, id === 'dots' ? 0.9 : 0.55) },
      };
    case 'glow':
    default:
      return {
        id: 'glow',
        bg: p.bg,
        layers: [
          { colors: [glow, clear], start: { x: 0, y: 0 }, end: { x: 0.75, y: 0.55 } },
          { colors: [clear2, glow2], start: { x: 0.3, y: 0.55 }, end: { x: 1, y: 1 } },
        ],
        pattern: null,
      };
  }
}

/**
 * The colours a background can show anywhere (for contrast): the plain background, and the
 * background under every layer's every stop, alone and stacked (the brightest point).
 */
export function backdropSamples(look: BackgroundLook): Rgb[] {
  const base = rgbOf(look.bg);
  const sum = (c: Rgb) => c[0] + c[1] + c[2];
  const out: Rgb[] = [base];
  let stacked = base; // every layer's brightest stop over the ones before: the brightest point
  for (const layer of look.layers) {
    let brightest = stacked;
    for (const c of layer.colors) {
      const over = composite(c, stacked);
      out.push(composite(c, base), over);
      if (sum(over) > sum(brightest)) brightest = over;
    }
    stacked = brightest;
  }
  out.push(stacked);
  if (look.pattern) out.push(...out.map((b) => composite(look.pattern!.color, b)));
  return out;
}

// ---- glass ----

/**
 * Glass at an amount (0..100%; 60 is how it was). One mapping for every surface:
 * - 0: flat, near-solid panes (no blur, no lens: the cheapest and the most readable);
 * - up to 60: the frost, lens and rim grow to the original look;
 * - up to 100: more blur and bend, a clearer pane. The rim's width never grows (Arpit: thin rims).
 * The flat fallback's pane (no blur available) never gets clearer than it was, so text on it keeps
 * its contrast; it only gets more solid below 60.
 */
export function glassAt(level: GlassLevel, amount: number): GlassStyle {
  const g = glass[level];
  const a = Math.min(100, Math.max(0, amount));
  if (a === DEFAULT_GLASS) return g; // the original tokens, untouched
  const up = a <= DEFAULT_GLASS ? a / DEFAULT_GLASS : 1; // 0..1 towards the original
  const over = a > DEFAULT_GLASS ? (a - DEFAULT_GLASS) / (100 - DEFAULT_GLASS) : 0; // 0..1 beyond it
  const [tr, tg, tb, ta] = rgbaOf(g.tint) as [number, number, number, number];
  const [fr, fg, fb, fa] = rgbaOf(g.flat) as [number, number, number, number];
  const tintAlpha = a <= DEFAULT_GLASS ? lerp(0.9, ta, up) : lerp(ta, ta * 0.55, over);
  const flatAlpha = a <= DEFAULT_GLASS ? lerp(0.98, fa, up) : fa;
  const rgb = (r: number, gg: number, b: number, al: number) => `rgba(${Math.round(r * 255)}, ${Math.round(gg * 255)}, ${Math.round(b * 255)}, ${fmt(al)})`;
  const scale = (v: number, most: number) => (a <= DEFAULT_GLASS ? v * up : v * lerp(1, most, over));
  const edgeAlpha = (css: string) => {
    const [r, gg, b, al] = rgbaOf(css) as [number, number, number, number];
    return rgb(r, gg, b, al * (a <= DEFAULT_GLASS ? lerp(0.35, 1, up) : 1));
  };
  return {
    blur: scale(g.blur, 1.5),
    tint: rgb(tr, tg, tb, tintAlpha),
    flat: rgb(fr, fg, fb, flatAlpha),
    edge: [edgeAlpha(g.edge[0]), edgeAlpha(g.edge[1])],
    highlight: edgeAlpha(g.highlight),
    refraction: scale(g.refraction, 1.6),
    bezel: g.bezel, // the bending band stays a thin edge
    dispersion: scale(g.dispersion, 1.4),
    saturation: 1 + scale(g.saturation - 1, 1.3),
    lift: scale(g.lift, 1.2),
    specular: scale(g.specular, 1.2),
    rimWidth: g.rimWidth, // thin, whatever the amount
  };
}

/** Whether surfaces draw real glass (blur, lens) at all: not at 0%, which is the flat look. */
export const glassOn = (amount: number) => amount > 0;

/** How strong the specular rim is at an amount (0..1; 1 at 60% and over). Its width never changes. */
export const rimStrength = (amount: number) => Math.min(1, Math.max(0, amount) / DEFAULT_GLASS) * 0.85 + (amount > 0 ? 0.15 : 0);

// ---- chat bubbles ----

export const INK_LIGHT = '#FFFFFF';
export const INK_DARK = '#000000';

export interface BubbleLook {
  fill: string; // the bubble's glass tint at this amount (translucent above 0%)
  edgeLit: string; // the light edge, top-left
  edgeDim: string; // bottom-right
  highlight: string; // the inner glow along the top
  ink: string; // the text: white or black, whichever reads best on every backdrop
  inkDim: string; // captions (time, ticks, "voice"): the ink, as faded as still reads at 4.5:1
  inkSoft: string; // the quote's pane inside the bubble
  worst: number; // the text's lowest contrast over the backdrops, for the tests
}

/**
 * A bubble's glass. `color` at `alpha60` is how it looks at 60%. Below that it gets more solid
 * without changing what it looks like on the plain background (premultiplied interpolation towards
 * that composite); above, clearer. The text is white or black, picked for the worst contrast over
 * every colour the background can show under the bubble, its top highlight included.
 */
export function bubbleLook(color: string, alpha60: number, amount: number, look: BackgroundLook): BubbleLook {
  const a = Math.min(100, Math.max(0, amount));
  const c = rgbOf(color);
  const base = rgbOf(look.bg);
  const solid: Rgb = [c[0] * alpha60 + base[0] * (1 - alpha60), c[1] * alpha60 + base[1] * (1 - alpha60), c[2] * alpha60 + base[2] * (1 - alpha60)];
  // Premultiplied: [r·α, g·α, b·α, α]
  const p60 = [c[0] * alpha60, c[1] * alpha60, c[2] * alpha60, alpha60];
  const p0 = [solid[0], solid[1], solid[2], 1];
  const t = a <= DEFAULT_GLASS ? a / DEFAULT_GLASS : (a - DEFAULT_GLASS) / (100 - DEFAULT_GLASS);
  const p = a <= DEFAULT_GLASS ? p0.map((v, i) => lerp(v, p60[i]!, t)) : p60.map((v) => v * lerp(1, 0.7, t));
  const alpha = p[3]!;
  const fill = alpha > 0 ? `rgba(${Math.round((p[0]! / alpha) * 255)}, ${Math.round((p[1]! / alpha) * 255)}, ${Math.round((p[2]! / alpha) * 255)}, ${fmt(alpha)})` : 'transparent';
  const shine = a <= DEFAULT_GLASS ? lerp(0.25, 1, t) : lerp(1, 1.3, t);
  const highlight = `rgba(255, 255, 255, ${fmt(0.06 * shine)})`;
  // What the text can sit on: the bubble over every backdrop colour, with and without the highlight.
  const under = backdropSamples(look).flatMap((b) => {
    const on = composite(fill, b);
    return [on, composite(highlight, on)];
  });
  const worstFor = (ink: string) => Math.min(...under.map((u) => contrast(rgbOf(ink), u)));
  const light = worstFor(INK_LIGHT);
  const dark = worstFor(INK_DARK);
  const ink = light >= dark ? INK_LIGHT : INK_DARK;
  const worst = Math.max(light, dark);
  // The faintest the captions can be and still read at 4.5:1 (the ink itself when nothing fainter does).
  let dimAlpha = 1;
  for (const al of [0.7, 0.78, 0.86, 0.94]) {
    const css = withAlpha(ink, al);
    if (Math.min(...under.map((u) => contrast(composite(css, u), u))) >= 4.5) {
      dimAlpha = al;
      break;
    }
  }
  return {
    fill,
    edgeLit: `rgba(255, 255, 255, ${fmt(0.22 * shine)})`,
    edgeDim: `rgba(255, 255, 255, ${fmt(0.04 * shine)})`,
    highlight,
    ink,
    inkDim: withAlpha(ink, dimAlpha),
    inkSoft: withAlpha(ink, 0.1),
    worst,
  };
}

/** A bubble's glass face as view style: its tint, and the light edge (bright top-left, dim bottom-right). */
export function bubbleFace(b: BubbleLook) {
  return { backgroundColor: b.fill, borderTopColor: b.edgeLit, borderLeftColor: b.edgeLit, borderRightColor: b.edgeDim, borderBottomColor: b.edgeDim };
}

// ---- the resolved theme ----

/** Everything that depends on the chosen appearance, resolved once per change. */
export interface Theme {
  appearance: Appearance;
  preset: ThemePreset;
  bg: string;
  accent: string;
  accentSoft: string;
  accentText: string; // text on an accent fill
  titleGlow: string; // the header title's glow
  background: BackgroundLook;
  glass: number; // the amount, 0..100 (0 when the system asks for less transparency)
  glassOf: (level: GlassLevel) => GlassStyle;
  rim: number; // the rim's strength, 0..1
  my: BubbleLook;
  edith: BubbleLook;
}

const MY_DEFAULT_ALPHA = 0.24; // the accent, as Arpit's bubbles were
const SWATCH_MOST = 0.6; // a chosen colour at most this strong (at 60%)
const EDITH_DEFAULT = { color: '#FFFFFF', alpha: 0.07 }; // EDITH's were a faint white pane
const FIT_AMOUNTS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
const FIT_MARGIN = 4.6; // a little over 4.5, for rounding on the way to the screen

const fitted = new Map<string, number>();

/**
 * How strong a bubble colour can be (its alpha at 60%) on a background with white text still
 * reading at 4.5:1 at every glass amount: Telegram's dark bubbles. Mid-tone colours (sky, yellow)
 * would otherwise land where neither white nor black text reads. Memoized per colour and background.
 */
export function fitBubbleAlpha(color: string, look: BackgroundLook, most = SWATCH_MOST): number {
  const key = `${color}|${look.id}|${look.bg}|${look.layers.map((l) => l.colors.join()).join(';')}|${look.pattern?.color ?? ''}`;
  const known = fitted.get(key);
  if (known !== undefined) return known;
  let alpha = 0.1;
  for (let a = most; a >= 0.1; a = Math.round((a - 0.02) * 100) / 100) {
    const ok = FIT_AMOUNTS.every((amount) => {
      const b = bubbleLook(color, a, amount, look);
      return b.ink === INK_LIGHT && b.worst >= FIT_MARGIN;
    });
    if (ok) {
      alpha = a;
      break;
    }
  }
  fitted.set(key, alpha);
  return alpha;
}

/** The theme for an appearance. `reduceTransparency`: the system asks for solid surfaces (glass 0). */
export function resolveTheme(appearance: Appearance, reduceTransparency = false): Theme {
  const preset = PRESETS.find((p) => p.id === appearance.theme) ?? PRESETS[0]!;
  const amount = reduceTransparency ? 0 : appearance.glass;
  const background = backgroundLook(preset, appearance.background);
  const swatch = (id: string | null) => SWATCHES.find((s) => s.id === id)?.color ?? null;
  const mine = swatch(appearance.myBubble);
  const hers = swatch(appearance.edithBubble);
  const accentRgb = rgbOf(preset.accent);
  const cache = new Map<GlassLevel, GlassStyle>();
  return {
    appearance,
    preset,
    bg: preset.bg,
    accent: preset.accent,
    accentSoft: withAlpha(preset.accent, 0.2),
    accentText: contrast(accentRgb, [0, 0, 0]) >= contrast(accentRgb, [1, 1, 1]) ? colors.accentText : colors.text,
    titleGlow: withAlpha(preset.accent, 0.75),
    background,
    glass: amount,
    glassOf: (level) => {
      let g = cache.get(level);
      if (!g) cache.set(level, (g = glassAt(level, amount)));
      return g;
    },
    rim: rimStrength(amount),
    my: bubbleLook(mine ?? preset.accent, mine ? fitBubbleAlpha(mine, background) : fitBubbleAlpha(preset.accent, background, MY_DEFAULT_ALPHA), amount, background),
    edith: bubbleLook(hers ?? EDITH_DEFAULT.color, hers ? fitBubbleAlpha(hers, background) : EDITH_DEFAULT.alpha, amount, background),
  };
}
