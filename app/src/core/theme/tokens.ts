// Design tokens (PLAN.md §4.11, "Liquid Glass"): black and grey glass, white text, and the logo's
// soft blue as the one accent. Every colour in the app comes from here; screens never use raw
// colour values (src/__tests__/no-raw-colours.test.ts checks).

/** The logo's colours (measured from app/assets/brand/edith-logo-source.jpg). */
export const brand = {
  blue: '#7CAEDC', // the rings' soft blue: the accent
  ink: '#10171D', // the source's background: icon background layer and splash
} as const;

export const colors = {
  bg: '#05070A', // near-black app background
  ambient: 'rgba(124, 174, 220, 0.16)', // the soft blue glow behind the glass
  ambientFar: 'rgba(124, 174, 220, 0.0)',
  text: '#F2F4F7',
  textDim: 'rgba(235, 240, 245, 0.62)',
  textFaint: 'rgba(235, 240, 245, 0.38)',
  textSecondary: '#D5DCE4', // secondary text on popup glass: opaque, never faded
  textShadow: 'rgba(0, 0, 0, 0.85)', // the dark halo under popup labels and icons (legibleText)
  accent: brand.blue,
  accentText: '#04121F', // text on an accent fill
  accentSoft: 'rgba(124, 174, 220, 0.20)',
  ok: '#8BD3A6',
  warn: '#E8C27A',
  danger: '#F08A8A',
  dangerSoft: 'rgba(240, 138, 138, 0.18)',
  hairline: 'rgba(255, 255, 255, 0.10)',
  scrim: 'rgba(0, 0, 0, 0.55)',
  ripple: 'rgba(255, 255, 255, 0.08)',
  input: 'rgba(255, 255, 255, 0.06)',
  card: 'rgba(255, 255, 255, 0.05)', // flat cards in lists (rows, chips, tool calls)
  cardRaised: 'rgba(255, 255, 255, 0.09)', // a card that stands out (system messages)
  // Bubbles and tool cards sit in long lists: flat (no blur), from the same palette.
  userBubble: 'rgba(124, 174, 220, 0.24)',
  assistantBubble: 'rgba(255, 255, 255, 0.07)',
  code: 'rgba(0, 0, 0, 0.35)',
  diffAdd: 'rgba(139, 211, 166, 0.14)',
  diffAddText: '#A7E3BD',
  diffDel: 'rgba(240, 138, 138, 0.14)',
  diffDelText: '#F5B0B0',
  diffHunk: '#A9CBEF',
  overlay: 'rgba(5, 7, 10, 0.66)', // over a thumbnail while it uploads
  overlayStrong: 'rgba(5, 7, 10, 0.8)', // small controls on a thumbnail (remove)
} as const;

/**
 * thin/regular/thick: chrome (the full frost and lens); control: the composer's pieces (a light
 * frost, as in Arpit's reference); panel: popups with text on them (menus, the status card).
 */
export type GlassLevel = 'thin' | 'regular' | 'thick' | 'control' | 'panel';

export interface GlassStyle {
  blur: number; // blur radius, dp (the frost: strong enough that text behind can't be read)
  tint: string; // laid over the frost
  flat: string; // the fallback without blur (battery saver, before Android 12): a tinted pane
  edge: readonly [string, string]; // the gradient light edge, top-left → bottom-right
  highlight: string; // the inner glow along the top
  // The lens (Android 13+, edith-glass's AGSL shader):
  refraction: number; // how far the very edge bends the backdrop, dp (grows towards the edge)
  bezel: number; // how wide the bending band at the edge is, dp (Arpit, 31 Oct: thin, a few dp)
  dispersion: number; // red/blue split at the rim, dp (about 2 px on a 3x screen)
  saturation: number; // 1 = unchanged; the frost lets colours glow through
  lift: number; // added brightness, 0..1: the frost's slight glow
  specular: number; // the thin highlight along the edge (brightest on top), 0..1
  rimWidth: number; // that highlight's width, dp
}

/** Glass surfaces, from the lightest (small pills) to the heaviest (the header). */
export const glass: Record<GlassLevel, GlassStyle> = {
  thin: {
    blur: 24,
    tint: 'rgba(30, 34, 40, 0.30)',
    flat: 'rgba(30, 34, 40, 0.92)',
    edge: ['rgba(255, 255, 255, 0.22)', 'rgba(255, 255, 255, 0.04)'],
    highlight: 'rgba(255, 255, 255, 0.06)',
    refraction: 4,
    bezel: 6,
    dispersion: 0.6,
    saturation: 1.6,
    lift: 0.03,
    specular: 0.45,
    rimWidth: 1.2,
  },
  regular: {
    blur: 28,
    tint: 'rgba(26, 30, 36, 0.28)',
    flat: 'rgba(26, 30, 36, 0.94)',
    edge: ['rgba(255, 255, 255, 0.26)', 'rgba(255, 255, 255, 0.05)'],
    highlight: 'rgba(255, 255, 255, 0.08)',
    refraction: 5,
    bezel: 7,
    dispersion: 0.6,
    saturation: 1.7,
    lift: 0.04,
    specular: 0.5,
    rimWidth: 1.2,
  },
  thick: {
    blur: 32,
    tint: 'rgba(20, 23, 28, 0.38)',
    flat: 'rgba(20, 23, 28, 0.96)',
    edge: ['rgba(255, 255, 255, 0.30)', 'rgba(255, 255, 255, 0.06)'],
    highlight: 'rgba(255, 255, 255, 0.10)',
    refraction: 5,
    bezel: 8,
    dispersion: 0.5,
    saturation: 1.5,
    lift: 0.03,
    specular: 0.4,
    rimWidth: 1.2,
  },
  control: {
    // The composer's pieces (Arpit's reference): a light, slightly blue frost, clearly lighter than
    // the background, with the rim on top.
    blur: 24,
    tint: 'rgba(170, 190, 225, 0.20)',
    flat: 'rgba(40, 46, 58, 0.96)',
    edge: ['rgba(255, 255, 255, 0.26)', 'rgba(255, 255, 255, 0.05)'],
    highlight: 'rgba(255, 255, 255, 0.07)',
    refraction: 4,
    bezel: 6,
    dispersion: 0.6,
    saturation: 1.7,
    lift: 0.02,
    specular: 0.45,
    rimWidth: 1.2,
  },
  panel: {
    // Popups carrying text (the menus, the status card): clear Liquid Glass with no pane of their own
    // (Arpit, 31 Oct). What's behind shows through, lightly blurred and only faintly tinted, and bends
    // in a thin band at the edge. The labels carry their own dark halo (legibleText) and a heavier
    // weight instead of sitting on a scrim. The flat fallback (no blur to calm what's behind) keeps a
    // tinted pane, so it still reads.
    blur: 14, // just enough that what's behind turns to colour and shapes, not competing text
    tint: 'rgba(16, 20, 28, 0.14)',
    flat: 'rgba(24, 30, 42, 0.90)',
    edge: ['rgba(255, 255, 255, 0.24)', 'rgba(255, 255, 255, 0.05)'],
    highlight: 'rgba(255, 255, 255, 0.04)',
    refraction: 4,
    bezel: 6,
    dispersion: 0.5,
    saturation: 1.4,
    lift: 0,
    specular: 0.4,
    rimWidth: 1.2,
  },
};

/**
 * The halo under popup text and icons: popups are clear glass with no pane behind the labels, so
 * each glyph carries its own dark, soft shadow (centred, a little low) that separates white text from
 * a bright backdrop. Android draws one shadow per Text, so it's strong and wide rather than stacked.
 */
export const legibleText = {
  textShadowColor: colors.textShadow,
  textShadowOffset: { width: 0, height: 0.5 },
  textShadowRadius: 6,
} as const;

/** The colour scheme a surface sits in. The app is dark today; the rim is ready for both. */
export type Scheme = 'dark' | 'light';

/**
 * The specular rim (Glass `rim`): light catching the glass edge. Three strokes, the usual
 * glassmorphism recipe redrawn as SVG (react-native-svg), so it looks the same with real glass,
 * blur only or the flat fallback:
 * - the rim: a thin gradient stroke along the diagonal, bright at the top-left and bottom-right
 *   corners and fading to nearly nothing at the top-right and bottom-left;
 * - the glow: the same gradient, wider and faint, just inside the rim (an inner highlight);
 * - the shade: a faint dark line inside the bottom edge (an inner shadow), so the pane reads thick.
 */
export interface RimStyle {
  lit: string; // the bright corners (top-left; bottom-right at `far`)
  mid: string; // a quarter of the way along
  dim: string; // the top-right and bottom-left: nearly transparent
  far: number; // the bottom-right corner's strength against the top-left, 0..1
  width: number; // the rim stroke, dp
  glow: number; // the inner highlight's opacity, 0..1
  glowWidth: number; // dp
  shade: string; // the inner shadow along the bottom
}

export const rims: Record<Scheme, RimStyle> = {
  dark: {
    // Arpit (31 Oct, from the 13R): as thin and about as bright as the old status pill's hairline
    // border (thin glass edge, 0.22 white). It was 1 dp at 0.78 plus a 3 dp inner glow: a thick
    // frame. Now under 2 px on the 13R, its corners a little brighter than the pill's edge (the
    // gradient fades to nearly nothing between them), and the inner glow scaled down with it.
    lit: 'rgba(255, 255, 255, 0.55)',
    mid: 'rgba(255, 255, 255, 0.16)',
    dim: 'rgba(255, 255, 255, 0.03)',
    far: 0.75,
    width: 0.5,
    glow: 0.25,
    glowWidth: 1,
    shade: 'rgba(0, 0, 0, 0.28)',
  },
  // On light glass a white line alone vanishes: brighter corners, and a slightly darker shade
  // to keep the pane's shape.
  light: {
    lit: 'rgba(255, 255, 255, 1)',
    mid: 'rgba(255, 255, 255, 0.45)',
    dim: 'rgba(255, 255, 255, 0.06)',
    far: 0.85,
    width: 1,
    glow: 0.5,
    glowWidth: 1,
    shade: 'rgba(15, 23, 42, 0.12)',
  },
};

/** 'rgba(r, g, b, a)' or '#rrggbb' → [r, g, b, a] in 0..1, the form the native glass view takes. */
export function rgbaOf(css: string): number[] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css);
  if (hex) return [parseInt(hex[1]!, 16) / 255, parseInt(hex[2]!, 16) / 255, parseInt(hex[3]!, 16) / 255, 1];
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(css);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])];
}

/** A token as an SVG gradient stop: an opaque '#rrggbb' and its opacity (stops take alpha apart). */
export function stopOf(css: string): { color: string; opacity: number } {
  const [r, g, b, a] = rgbaOf(css);
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return { color: `#${hex(r!)}${hex(g!)}${hex(b!)}`, opacity: a! };
}

/** Each level's tint for the native view, parsed once. */
/** The opaque colour under the frost: the app's background (the backdrop can be transparent between things). */
export const glassBase: number[] = rgbaOf(colors.bg);

export const glassTint: Record<GlassLevel, number[]> = {
  thin: rgbaOf(glass.thin.tint),
  regular: rgbaOf(glass.regular.tint),
  thick: rgbaOf(glass.thick.tint),
  control: rgbaOf(glass.control.tint),
  panel: rgbaOf(glass.panel.tint),
};

export const radius = { s: 8, m: 14, l: 22, pill: 999 } as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;

export const type = {
  mono: 'monospace',
  size: { caption: 11, small: 13, body: 15, title: 17, heading: 22 },
} as const;

/**
 * Motion (PLAN.md §4.11 "liquid motion"): durations for fades, and springs for anything that moves.
 * All run on the UI thread (Reanimated); with "Remove animations" on they jump to the end.
 */
export const motion = {
  fast: 120,
  normal: 220,
  slow: 360,
  spring: { damping: 18, stiffness: 180, mass: 1 },
  press: { damping: 15, stiffness: 420, mass: 0.6 }, // squish on press: quick in, a small rebound out
  settle: { damping: 16, stiffness: 220, mass: 1 }, // a new bubble settling into place
  grow: { damping: 17, stiffness: 260, mass: 0.9 }, // a sheet growing out of its trigger
  pressScale: 0.95,
  blobMs: 2400, // one breath of the working blob
  bubbleMs: 4200, // one cycle of the thinking bubble's wobble and swirl
  swipe: { damping: 20, stiffness: 320, mass: 0.7 }, // a swiped message springing back
} as const;

/** The header the shell lays over the content (screens pad by it; see useChrome()). */
export const chrome = { headerHeight: 52 } as const;

/**
 * The header title's glow (Arpit's ask): the logo's soft blue as a static text shadow with no
 * offset. Soft enough that the white glyphs stay crisp; it costs nothing per frame.
 */
export const titleGlow = {
  textShadowColor: 'rgba(124, 174, 220, 0.75)',
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 10,
} as const;

/**
 * The thinking bubble (ui/ThinkingBubble): an orb like Arpit's reference, in the app icon's
 * colours (app/assets/icon.png): silver-white bands, the rings' soft blue and a deeper rim blue,
 * with a faint lavender sheen for the soap-bubble shimmer.
 */
export const bubble = {
  core: 'rgba(16, 23, 29, 0.55)', // the icon's ink, see-through: the middle of the orb
  body: 'rgba(124, 174, 220, 0.30)', // the soft blue the body fades to at the edge
  rimLit: '#E8EEF6', // the silver catching light (top-left)
  rimMid: brand.blue,
  rimDeep: '#4F7FD0', // the icon's deeper blue on the rim's far side
  sheen: 'rgba(176, 164, 236, 0.60)', // a lavender shimmer on the rim
  bandSilver: 'rgba(232, 238, 246, 0.85)',
  bandBlue: 'rgba(124, 174, 220, 0.85)',
  bandDeep: 'rgba(96, 140, 222, 0.80)',
} as const;
