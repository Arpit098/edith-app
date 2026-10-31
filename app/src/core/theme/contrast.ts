// WCAG 2.x contrast for glass: how text reads on a popup over any backdrop. Android composites
// views in sRGB-encoded space, so a layer of colour c at alpha a over b is c·a + b·(1 − a) per
// channel, and contrast uses the relative luminance of the result.

import { glass, rgbaOf, type GlassLevel } from './tokens';

export type Rgb = readonly [number, number, number]; // sRGB-encoded, 0..1

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, 1..21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** A CSS colour (with its alpha) laid over an opaque colour. */
export function composite(css: string, under: Rgb): Rgb {
  const [r, g, b, a] = rgbaOf(css) as [number, number, number, number];
  return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
}

/** Backdrops a popup can sit over: pure white is the worst for light text; the others for the record. */
export const BACKDROPS: Record<string, Rgb> = {
  white: [1, 1, 1],
  black: [0, 0, 0],
  grey: [0.5, 0.5, 0.5],
  yellow: [1, 0.9, 0.2],
  cyan: [0.4, 0.9, 1],
  red: [0.95, 0.25, 0.25],
};

/**
 * The lowest contrast of `text` on a popup of `level`, over every backdrop, in every glass mode.
 * Deliberately pessimistic: the glass itself (frost, tint) is assumed to let the backdrop through
 * unchanged, at full brightness; only what's drawn over it in JS is counted: the flat fallback's
 * colour in flat mode, then the content area's scrim. So the number holds whatever the native view
 * does (lens, blur only, or a failure), and on every device.
 */
export function worstPopupContrast(level: GlassLevel, text: string): number {
  const g = glass[level];
  if (!g.legibility) throw new Error(`${level} isn't a popup level`);
  let worst = Infinity;
  for (const backdrop of Object.values(BACKDROPS)) {
    for (const surface of [backdrop, composite(g.flat, backdrop)]) {
      const bg = composite(g.legibility.scrim, surface);
      worst = Math.min(worst, contrast(composite(text, bg), bg));
    }
  }
  return worst;
}
