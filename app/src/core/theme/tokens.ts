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

export type GlassLevel = 'thin' | 'regular' | 'thick';

export interface GlassStyle {
  blur: number; // blur radius, dp
  tint: string; // laid over the blurred backdrop
  flat: string; // the fallback without blur: the tint alone, a little more opaque
  edge: readonly [string, string]; // the gradient light edge, top-left → bottom-right
  highlight: string; // the inner glow along the top
  // The lens (Android 13+, edith-glass's AGSL shader):
  refraction: number; // how far the rim bends the backdrop, dp
  bezel: number; // how wide the refracting rim is, dp
  dispersion: number; // colour fringe at the rim, 0..1
  saturation: number; // 1 = unchanged; glass lifts colour a little
  specular: number; // rim highlight from the top-left, 0..1
}

/** Glass surfaces, from the lightest (small pills) to the heaviest (the header). */
export const glass: Record<GlassLevel, GlassStyle> = {
  thin: {
    blur: 14,
    tint: 'rgba(28, 32, 38, 0.38)',
    flat: 'rgba(30, 34, 40, 0.78)',
    edge: ['rgba(255, 255, 255, 0.22)', 'rgba(255, 255, 255, 0.04)'],
    highlight: 'rgba(255, 255, 255, 0.06)',
    refraction: 10,
    bezel: 12,
    dispersion: 0.25,
    saturation: 1.35,
    specular: 0.35,
  },
  regular: {
    blur: 20,
    tint: 'rgba(24, 28, 34, 0.52)',
    flat: 'rgba(26, 30, 36, 0.88)',
    edge: ['rgba(255, 255, 255, 0.26)', 'rgba(255, 255, 255, 0.05)'],
    highlight: 'rgba(255, 255, 255, 0.08)',
    refraction: 14,
    bezel: 16,
    dispersion: 0.3,
    saturation: 1.4,
    specular: 0.4,
  },
  thick: {
    blur: 28,
    tint: 'rgba(18, 21, 26, 0.66)',
    flat: 'rgba(20, 23, 28, 0.94)',
    edge: ['rgba(255, 255, 255, 0.30)', 'rgba(255, 255, 255, 0.06)'],
    highlight: 'rgba(255, 255, 255, 0.10)',
    refraction: 12,
    bezel: 18,
    dispersion: 0.2,
    saturation: 1.3,
    specular: 0.3,
  },
};

/** 'rgba(r, g, b, a)' → [r, g, b, a] in 0..1, the form the native glass view takes. */
export function rgbaOf(css: string): number[] {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(css);
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])];
}

/** Each level's tint for the native view, parsed once. */
export const glassTint: Record<GlassLevel, number[]> = { thin: rgbaOf(glass.thin.tint), regular: rgbaOf(glass.regular.tint), thick: rgbaOf(glass.thick.tint) };

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
  // The tab droplet: the leading edge leaps, the trailing edge follows softer, so it stretches and settles.
  dropletLead: { damping: 20, stiffness: 420, mass: 0.8 },
  dropletTrail: { damping: 22, stiffness: 170, mass: 1 },
  pressScale: 0.95,
  blobMs: 2400, // one breath of the working blob
} as const;

/** Chrome sizes the shell lays over the content (screens pad by these; see useChrome()). */
export const chrome = { headerHeight: 52, tabBarHeight: 60 } as const;
