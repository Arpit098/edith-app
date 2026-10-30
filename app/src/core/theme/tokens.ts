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

/**
 * Glass surfaces. `tint` is laid over the blur (or used alone in the flat fallback, hence the
 * separate `flat` value, a little more opaque); `edge` is the gradient light edge from the top-left;
 * `highlight` the inner glow along the top.
 */
export const glass: Record<GlassLevel, { blur: number; tint: string; flat: string; edge: readonly [string, string]; highlight: string }> = {
  thin: {
    blur: 24,
    tint: 'rgba(28, 32, 38, 0.38)',
    flat: 'rgba(30, 34, 40, 0.78)',
    edge: ['rgba(255, 255, 255, 0.22)', 'rgba(255, 255, 255, 0.04)'],
    highlight: 'rgba(255, 255, 255, 0.06)',
  },
  regular: {
    blur: 40,
    tint: 'rgba(24, 28, 34, 0.52)',
    flat: 'rgba(26, 30, 36, 0.88)',
    edge: ['rgba(255, 255, 255, 0.26)', 'rgba(255, 255, 255, 0.05)'],
    highlight: 'rgba(255, 255, 255, 0.08)',
  },
  thick: {
    blur: 60,
    tint: 'rgba(18, 21, 26, 0.66)',
    flat: 'rgba(20, 23, 28, 0.94)',
    edge: ['rgba(255, 255, 255, 0.30)', 'rgba(255, 255, 255, 0.06)'],
    highlight: 'rgba(255, 255, 255, 0.10)',
  },
};

export const radius = { s: 8, m: 14, l: 22, pill: 999 } as const;

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const;

export const type = {
  mono: 'monospace',
  size: { caption: 11, small: 13, body: 15, title: 17, heading: 22 },
} as const;

/** Motion: short, soft, no bounce on content (springs are for sheets in Phase 3). */
export const motion = {
  fast: 120,
  normal: 220,
  slow: 360,
  spring: { damping: 18, stiffness: 180, mass: 1 },
} as const;

/** Chrome sizes the shell lays over the content (screens pad by these; see useChrome()). */
export const chrome = { headerHeight: 52, tabBarHeight: 60 } as const;
