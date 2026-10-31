// Themes (Settings → Appearance): Telegram-like presets that set the background, its glow and the
// accent; a colour or gradient for each side's chat bubbles; the background drawn behind everything
// (in the theme's colours, a gradient preset, or one built with "Custom…"); the accent, which can
// override the theme's; and how much glass there is (0..100%). Pure data and maths:
// core/theme/index.ts provides the active theme to the app, ui/ draws it. All looks are dark, so the
// neutral tokens (text, danger…) stay in tokens.ts; only what a theme changes is here.

import { contrast, composite, luminance, type Rgb } from './contrast';
import {
  ACCENTS,
  anglePoints,
  BUBBLE_GRADIENTS,
  CUSTOM_BUBBLE,
  GRADIENT_BACKGROUNDS,
  MAX_CUSTOM,
  normalizeBubbleGradient,
  normalizeGradient,
  radialCenter,
  tame,
  type BubbleGradient,
  type CustomGradient,
  type GradientSpec,
} from './gradients';
import { colors, glass, rgbaOf, type GlassLevel, type GlassStyle } from './tokens';

export * from './gradients';

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

/** The bubble colours offered for each side (besides "Theme default" and the gradients). */
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

/** The backgrounds in the theme's own colours (the gradient ones are in gradients.ts). */
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
  /** A swatch id, a gradient's id (BUBBLE_GRADIENTS), 'custom' (that side's own gradient); null: the theme's. */
  myBubble: string | null;
  edithBubble: string | null;
  myGradient: BubbleGradient | null; // my own bubble gradient (kept while another choice is picked)
  edithGradient: BubbleGradient | null;
  /** A BackgroundId (in the theme's colours), a gradient background's id, or a custom one's. */
  background: string;
  customGradients: CustomGradient[]; // up to MAX_CUSTOM, built with "Custom…"
  accent: string | null; // an ACCENTS id; null: the theme's
  glass: number; // 0..100
}

export const DEFAULT_GLASS = 60; // the look the app had before the slider
export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'midnight',
  myBubble: null,
  edithBubble: null,
  myGradient: null,
  edithGradient: null,
  background: 'glow',
  customGradients: [],
  accent: null,
  glass: DEFAULT_GLASS,
};

/**
 * A stored or partial appearance, made whole and valid. What was stored before a field existed
 * (appearance.v1 first had theme, bubbles, background and glass) keeps its meaning; a missing or
 * unknown field takes its default, and a choice that points at nothing (a deleted custom gradient,
 * 'custom' with no gradient) falls back to the default too.
 */
export function normalizeAppearance(v: unknown): Appearance {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const g = typeof o.glass === 'number' && Number.isFinite(o.glass) ? Math.round(Math.min(100, Math.max(0, o.glass))) : DEFAULT_GLASS;
  const myGradient = normalizeBubbleGradient(o.myGradient);
  const edithGradient = normalizeBubbleGradient(o.edithGradient);
  const bubble = (x: unknown, own: BubbleGradient | null) =>
    typeof x === 'string' && (SWATCHES.some((s) => s.id === x) || BUBBLE_GRADIENTS.some((b) => b.id === x) || (x === CUSTOM_BUBBLE && own !== null)) ? x : null;
  const customGradients: CustomGradient[] = [];
  for (const c of Array.isArray(o.customGradients) ? o.customGradients : []) {
    if (customGradients.length === MAX_CUSTOM) break;
    const id = (c as { id?: unknown } | null)?.id;
    const spec = normalizeGradient(c);
    if (spec && typeof id === 'string' && /^custom-\d+$/.test(id) && !customGradients.some((x) => x.id === id)) customGradients.push({ id, ...spec });
  }
  return {
    theme: typeof o.theme === 'string' && PRESETS.some((p) => p.id === o.theme) ? o.theme : DEFAULT_APPEARANCE.theme,
    myBubble: bubble(o.myBubble, myGradient),
    edithBubble: bubble(o.edithBubble, edithGradient),
    myGradient,
    edithGradient,
    background: typeof o.background === 'string' && isBackground(o.background, customGradients) ? o.background : DEFAULT_APPEARANCE.background,
    customGradients,
    accent: typeof o.accent === 'string' && ACCENTS.some((a) => a.id === o.accent) ? o.accent : null,
    glass: g,
  };
}

const isBackground = (id: string, customs: readonly CustomGradient[]) =>
  BACKGROUNDS.some((b) => b.id === id) || GRADIENT_BACKGROUNDS.some((b) => b.id === id) || customs.some((c) => c.id === id);

/** The id for a new custom gradient: one more than the highest so far (ids are never reused while kept). */
export function nextCustomId(customs: readonly CustomGradient[]): string {
  return `custom-${customs.reduce((n, c) => Math.max(n, Number(c.id.slice('custom-'.length)) || 0), 0) + 1}`;
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
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const MID = [0.25, 0.5, 0.75]; // where a gradient is sampled between two stops

// ---- the background behind everything ----

/** One layer of a background: a gradient through 2+ colours (CSS, with alpha), evenly spaced. */
export type BackgroundLayer =
  | { kind?: 'linear'; colors: readonly [string, string, ...string[]]; start: { x: number; y: number }; end: { x: number; y: number } }
  | { kind: 'radial'; colors: readonly [string, string, ...string[]]; center: { x: number; y: number }; radius: number };

export interface BackgroundLook {
  id: string;
  bg: string; // opaque: what's under the layers (and under the glass's frost)
  layers: BackgroundLayer[];
  pattern: { kind: 'dots' | 'grid'; color: string } | null;
  drift: boolean; // the first layer drifts slowly (gradients' "drift" variants)
}

/** A gradient spec as a background: its stops tamed to its intensity (dark enough for text), on its darkest stop. */
export function gradientLook(id: string, spec: GradientSpec, drift = false): BackgroundLook {
  const stops = spec.stops.map((s) => tame(s, spec.intensity));
  const darkest = stops.reduce((a, b) => (luminance(rgbOf(b)) < luminance(rgbOf(a)) ? b : a));
  const colors = stops as unknown as readonly [string, string, ...string[]];
  const layer: BackgroundLayer = spec.kind === 'radial' ? { kind: 'radial', colors, center: radialCenter(spec.angle), radius: 0.85 } : { kind: 'linear', colors, ...anglePoints(spec.angle) };
  return { id, bg: darkest, layers: [layer], pattern: null, drift };
}

/** A background as drawn: in the theme's colours (BACKGROUNDS), a gradient preset, or a custom gradient. */
export function backgroundLook(p: ThemePreset, id: string, customs: readonly CustomGradient[] = []): BackgroundLook {
  const preset = GRADIENT_BACKGROUNDS.find((b) => b.id === id);
  if (preset) return gradientLook(id, preset.spec, preset.drift);
  const custom = customs.find((c) => c.id === id);
  if (custom) return gradientLook(id, custom);
  const glow = withAlpha(p.glow, p.glowAlpha);
  const glow2 = withAlpha(p.glow2, p.glowAlpha * 0.6);
  const clear = withAlpha(p.glow, 0);
  const clear2 = withAlpha(p.glow2, 0);
  const soft = (c: string, a: number) => withAlpha(c, Math.max(p.glowAlpha, 0.08) * a); // OLED: a faint pattern still
  const look = (bid: BackgroundId, layers: BackgroundLayer[], pattern: BackgroundLook['pattern'] = null): BackgroundLook => ({ id: bid, bg: p.bg, layers, pattern, drift: false });
  switch (id as BackgroundId) {
    case 'plain':
      return look('plain', []);
    case 'sweep':
      return look('sweep', [{ colors: [glow, withAlpha(p.glow2, p.glowAlpha * 0.9)], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }]);
    case 'horizon':
      return look('horizon', [{ colors: [clear, withAlpha(p.glow, p.glowAlpha * 1.2), withAlpha(p.glow2, p.glowAlpha * 0.5), clear2], start: { x: 0.5, y: 0.35 }, end: { x: 0.5, y: 1 } }]);
    case 'dots':
    case 'grid':
      return look(id as 'dots' | 'grid', [{ colors: [glow, clear], start: { x: 0, y: 0 }, end: { x: 0.75, y: 0.55 } }], {
        kind: id as 'dots' | 'grid',
        // Dots a little fainter than first shipped (0.9): on Aurora's brightest glow a dot under dim
        // text or the blue accent fell just under 4.5:1.
        color: soft(p.glow === p.bg ? '#FFFFFF' : p.glow, id === 'dots' ? 0.7 : 0.55),
      });
    case 'glow':
    default:
      return look('glow', [
        { colors: [glow, clear], start: { x: 0, y: 0 }, end: { x: 0.75, y: 0.55 } },
        { colors: [clear2, glow2], start: { x: 0.3, y: 0.55 }, end: { x: 1, y: 1 } },
      ]);
  }
}

/**
 * The colours a background can show anywhere (for contrast): the plain background, and the
 * background under every layer's every stop and the points between them, alone and stacked (the
 * brightest point), with the pattern over all of those.
 */
export function backdropSamples(look: BackgroundLook): Rgb[] {
  const base = rgbOf(look.bg);
  const sum = (c: Rgb) => c[0] + c[1] + c[2];
  const out: Rgb[] = [base];
  let stacked = base; // every layer's brightest stop over the ones before: the brightest point
  for (const layer of look.layers) {
    let brightest = stacked;
    const alone = layer.colors.map((c) => composite(c, base));
    const over = layer.colors.map((c) => composite(c, stacked));
    for (let i = 0; i < over.length; i++) {
      out.push(alone[i]!, over[i]!);
      if (sum(over[i]!) > sum(brightest)) brightest = over[i]!;
      if (i > 0) for (const t of MID) out.push(mix(alone[i - 1]!, alone[i]!, t), mix(over[i - 1]!, over[i]!, t));
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
  fill: string; // the bubble's glass tint at this amount (translucent above 0%); a gradient's first stop
  /** A gradient bubble's tint, stop by stop, and its direction; null for one colour. */
  gradient: { colors: readonly [string, string, ...string[]]; start: { x: number; y: number }; end: { x: number; y: number } } | null;
  edgeLit: string; // the light edge, top-left (its top is the bubble's sheen)
  edgeDim: string; // bottom-right
  ink: string; // the text: white or black, whichever reads best everywhere on the bubble, on every backdrop
  inkDim: string; // captions (time, ticks, "voice"): the ink, as faded as still reads at 4.5:1
  inkSoft: string; // the quote's pane inside the bubble (full ink reads at 4.5:1 on it)
  quoteDim: string; // the quote's text on that pane: as faded as still reads at 4.5:1 there
  worst: number; // the text's lowest contrast over the bubble and the backdrops, for the tests
}

/**
 * A bubble's glass: one colour, or a gradient through `color`'s stops at `angle`. `alpha60` is how
 * strong it is at 60%. Below that it gets more solid without changing what it looks like on the
 * plain background (premultiplied interpolation towards that composite); above, clearer. The text is
 * white or black, picked for the worst contrast over every point of the bubble (each stop and the
 * points between them) over every colour the background can show under it.
 */
export function bubbleLook(color: string | readonly string[], alpha60: number, amount: number, look: BackgroundLook, angle = 135): BubbleLook {
  const a = Math.min(100, Math.max(0, amount));
  const stops = typeof color === 'string' ? [color] : color;
  const base = rgbOf(look.bg);
  const t = a <= DEFAULT_GLASS ? a / DEFAULT_GLASS : (a - DEFAULT_GLASS) / (100 - DEFAULT_GLASS);
  const fillOf = (stop: string) => {
    const p = tintAt(rgbOf(stop), alpha60, a, base);
    const alpha = p[3];
    return alpha > 0 ? `rgba(${Math.round((p[0] / alpha) * 255)}, ${Math.round((p[1] / alpha) * 255)}, ${Math.round((p[2] / alpha) * 255)}, ${fmt(alpha)})` : 'transparent';
  };
  const fills = stops.map(fillOf);
  const shine = a <= DEFAULT_GLASS ? lerp(0.25, 1, t) : lerp(1, 1.3, t);
  // What the text can sit on: every point of the bubble over every backdrop colour. Every stop has
  // the same alpha, so the gradient between two stops is the mix of their composites.
  const under: Rgb[] = [];
  const tints = fills.map((f) => rgbaOf(f) as [number, number, number, number]);
  for (const b of samplesOf(look)) {
    const each = tints.map((c) => over(c, b));
    for (let i = 0; i < each.length; i++) {
      under.push(each[i]!);
      if (i > 0) for (const m of MID) under.push(mix(each[i - 1]!, each[i]!, m));
    }
  }
  const light = worstOn(INK_LIGHT, under);
  const dark = worstOn(INK_DARK, under);
  const ink = light >= dark ? INK_LIGHT : INK_DARK;
  const worst = Math.max(light, dark);
  // The quote's pane inside the bubble: the ink, faintly, as strong as it can be with the full ink
  // still at 4.5:1 on it (a white pane brightens the bubble under white text).
  const inkRgb = rgbOf(ink);
  const paneOf = (al: number) => under.map((u) => over([inkRgb[0], inkRgb[1], inkRgb[2], al], u));
  let paneAlpha = 0;
  for (const al of [0.1, 0.08, 0.06, 0.04, 0.02]) {
    if (worstOn(ink, paneOf(al)) >= 4.5) {
      paneAlpha = al;
      break;
    }
  }
  const onPane = paneOf(paneAlpha);
  return {
    fill: fills[0]!,
    gradient: fills.length > 1 ? { colors: fills as unknown as readonly [string, string, ...string[]], ...anglePoints(angle) } : null,
    edgeLit: `rgba(255, 255, 255, ${fmt(0.22 * shine)})`,
    edgeDim: `rgba(255, 255, 255, ${fmt(0.04 * shine)})`,
    ink,
    inkDim: faintest(ink, under),
    inkSoft: withAlpha(ink, paneAlpha),
    quoteDim: faintest(ink, onPane),
    worst,
  };
}

/**
 * A bubble colour's tint at a glass amount, premultiplied [r·α, g·α, b·α, α]: at 60% the colour at
 * alpha60; below, towards its solid composite on the plain background; above, clearer.
 */
function tintAt(c: Rgb, alpha60: number, amount: number, base: Rgb): [number, number, number, number] {
  const p60 = [c[0] * alpha60, c[1] * alpha60, c[2] * alpha60, alpha60] as const;
  if (amount > DEFAULT_GLASS) {
    const k = lerp(1, 0.7, (amount - DEFAULT_GLASS) / (100 - DEFAULT_GLASS));
    return [p60[0] * k, p60[1] * k, p60[2] * k, p60[3] * k];
  }
  const t = amount / DEFAULT_GLASS;
  const solid = mix(base, c, alpha60);
  return [lerp(solid[0], p60[0], t), lerp(solid[1], p60[1], t), lerp(solid[2], p60[2], t), lerp(1, p60[3], t)];
}

// Backdrop samples per background, kept: a theme change re-resolves both bubbles, and the fit below
// asks for them hundreds of times. Bounded: the builder makes a new background on every change.
const SAMPLES_KEPT = 64;
const samplesKept = new Map<string, Rgb[]>();
const lookKey = (look: BackgroundLook) => `${look.id}|${look.bg}|${look.layers.map((l) => l.colors.join()).join(';')}|${look.pattern?.color ?? ''}`;
function samplesOf(look: BackgroundLook): Rgb[] {
  const key = lookKey(look);
  let s = samplesKept.get(key);
  if (!s) {
    if (samplesKept.size >= SAMPLES_KEPT) samplesKept.clear();
    samplesKept.set(key, (s = backdropSamples(look)));
  }
  return s;
}

/** The ink as faded as it can be and still read at 4.5:1 on every ground (the ink itself if nothing fainter does). */
function faintest(ink: string, grounds: Rgb[]): string {
  for (const al of [0.7, 0.78, 0.86, 0.94]) {
    if (worstOn(withAlpha(ink, al), grounds) >= 4.5) return withAlpha(ink, al);
  }
  return ink;
}

/** A straight-alpha colour [r, g, b, a] over an opaque one. */
const over = (c: readonly [number, number, number, number], u: Rgb): Rgb => [c[0] * c[3] + u[0] * (1 - c[3]), c[1] * c[3] + u[1] * (1 - c[3]), c[2] * c[3] + u[2] * (1 - c[3])];

/** The lowest contrast of `css` (parsed once) laid over each ground, against that ground. */
function worstOn(css: string, grounds: readonly Rgb[]): number {
  const c = rgbaOf(css) as [number, number, number, number];
  let least = Infinity;
  for (const u of grounds) least = Math.min(least, contrast(over(c, u), u));
  return least;
}

/**
 * White or black, whichever reads best on `css` (translucent colours laid over `ground`): marks on
 * swatches. For a gradient's stops, the one whose worst contrast over the stops and between them is best.
 */
export function inkOn(css: string | readonly string[], ground: string): string {
  const g = rgbOf(ground);
  const each = (typeof css === 'string' ? [css] : css).map((c) => composite(c, g));
  const under = each.flatMap((u, i) => (i > 0 ? [...MID.map((m) => mix(each[i - 1]!, u, m)), u] : [u]));
  const worst = (ink: string) => Math.min(...under.map((u) => contrast(rgbOf(ink), u)));
  return worst(INK_DARK) > worst(INK_LIGHT) ? INK_DARK : INK_LIGHT;
}

/**
 * A bubble's glass face as view style: its tint, and the light edge (bright top-left, dim
 * bottom-right). A gradient bubble's tint is drawn by ui/BubbleFill inside it, so its own is clear.
 */
export function bubbleFace(b: BubbleLook) {
  return { backgroundColor: b.gradient ? 'transparent' : b.fill, borderTopColor: b.edgeLit, borderLeftColor: b.edgeLit, borderRightColor: b.edgeDim, borderBottomColor: b.edgeDim };
}

// ---- the resolved theme ----

/** Everything that depends on the chosen appearance, resolved once per change. */
export interface Theme {
  appearance: Appearance;
  preset: ThemePreset;
  bg: string; // the background's base (opaque)
  accent: string; // the chosen accent, or the theme's
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

const FITS_KEPT = 256; // bounded: every custom gradient's colours make new ones
const fitted = new Map<string, number>();
// White text at FIT_MARGIN:1 or more on a colour means its luminance is at most this.
const WHITE_READS_UNDER = 1.05 / FIT_MARGIN - 0.05;

/**
 * How strong a bubble colour (or every stop of a gradient) can be (its alpha at 60%) on a background
 * with white text still reading at 4.5:1 at every glass amount, all over the bubble: Telegram's dark
 * bubbles. Mid-tone colours (sky, yellow) would otherwise land where neither white nor black text
 * reads. Memoized per colour and background.
 *
 * Only the stops need checking: luminance is convex along a gradient (each channel's light is a
 * convex function of its encoded value), so between two stops it never rises above both, and white
 * text reads there if it reads on them. And white at FIT_MARGIN > √21 is always the better ink, so
 * this is exactly "bubbleLook picks white, at FIT_MARGIN or more", at a fraction of the cost (a new
 * custom colour is fitted on the phone as it's picked).
 */
export function fitBubbleAlpha(color: string | readonly string[], look: BackgroundLook, most = SWATCH_MOST): number {
  const stops = typeof color === 'string' ? [color] : color;
  const key = `${stops.join('>')}|${most}|${lookKey(look)}`;
  const known = fitted.get(key);
  if (known !== undefined) return known;
  const colours = stops.map(rgbOf);
  const base = rgbOf(look.bg);
  const samples = samplesOf(look);
  const reads = (alpha60: number) =>
    FIT_AMOUNTS.every((amount) =>
      colours.every((c) => {
        const [r, g, b, al] = tintAt(c, alpha60, amount, base);
        return samples.every((u) => luminance([r + u[0] * (1 - al), g + u[1] * (1 - al), b + u[2] * (1 - al)]) <= WHITE_READS_UNDER);
      }),
    );
  let alpha = 0.1;
  for (let a = most; a >= 0.1; a = Math.round((a - 0.02) * 100) / 100) {
    if (reads(a)) {
      alpha = a;
      break;
    }
  }
  if (fitted.size >= FITS_KEPT) fitted.clear();
  fitted.set(key, alpha);
  return alpha;
}

/** What a side's bubble choice is: a colour or a gradient's stops and angle; null for the default. */
export function bubbleChoice(id: string | null, own: BubbleGradient | null): { stops: readonly string[]; angle: number } | null {
  if (id === null) return null;
  const swatch = SWATCHES.find((s) => s.id === id);
  if (swatch) return { stops: [swatch.color], angle: 135 };
  const preset = BUBBLE_GRADIENTS.find((b) => b.id === id);
  if (preset) return preset.gradient;
  return id === CUSTOM_BUBBLE && own ? own : null;
}

function sideLook(choice: ReturnType<typeof bubbleChoice>, fallback: { color: string; alpha: number }, amount: number, background: BackgroundLook): BubbleLook {
  if (!choice) return bubbleLook(fallback.color, fallback.alpha, amount, background);
  const stops = choice.stops.length === 1 ? choice.stops[0]! : choice.stops;
  return bubbleLook(stops, fitBubbleAlpha(stops, background), amount, background, choice.angle);
}

/** The theme for an appearance. `reduceTransparency`: the system asks for solid surfaces (glass 0). */
export function resolveTheme(appearance: Appearance, reduceTransparency = false): Theme {
  const preset = PRESETS.find((p) => p.id === appearance.theme) ?? PRESETS[0]!;
  const amount = reduceTransparency ? 0 : appearance.glass;
  const background = backgroundLook(preset, appearance.background, appearance.customGradients);
  const accent = ACCENTS.find((a) => a.id === appearance.accent)?.color ?? preset.accent;
  const accentRgb = rgbOf(accent);
  const cache = new Map<GlassLevel, GlassStyle>();
  return {
    appearance,
    preset,
    bg: background.bg,
    accent,
    accentSoft: withAlpha(accent, 0.2),
    accentText: contrast(accentRgb, [0, 0, 0]) >= contrast(accentRgb, [1, 1, 1]) ? colors.accentText : colors.text,
    titleGlow: withAlpha(accent, 0.75),
    background,
    glass: amount,
    glassOf: (level) => {
      let g = cache.get(level);
      if (!g) cache.set(level, (g = glassAt(level, amount)));
      return g;
    },
    rim: rimStrength(amount),
    my: sideLook(bubbleChoice(appearance.myBubble, appearance.myGradient), { color: accent, alpha: fitBubbleAlpha(accent, background, MY_DEFAULT_ALPHA) }, amount, background),
    edith: sideLook(bubbleChoice(appearance.edithBubble, appearance.edithGradient), { color: EDITH_DEFAULT.color, alpha: EDITH_DEFAULT.alpha }, amount, background),
  };
}
