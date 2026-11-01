// Photo wallpapers (Settings → Appearance → Background → "Your photo…"): Arpit's own picture behind
// the chat, under the glass. Pure data and maths; the picking, downscaling and files are an adapter's
// (adapters/media/expo/wallpapers.ts), the drawing is ui/Ambient's, the readability themes.ts's.
//
// Readability can't be left to the photo: when a photo is picked, the adapter shrinks it to a small
// grid of colours (each an average over a patch of the picture), and `photoTones` keeps the ones
// that matter for text: the mean, the brightest patches and the darkest. themes.ts checks the
// app's text and both bubbles against those after the dim and tint, and dims further when they'd fail.

import { luminance, type Rgb } from './contrast';
import { hexOf, isHex } from './gradients';

export const MAX_PHOTOS = 3; // kept as tiles, newest first; a fourth replaces the oldest (its file is deleted)
export const PHOTO_BLUR_MAX = 20;
export const PHOTO_DIM_MAX = 80; // the slider's top; readability may dim further (PHOTO_DIM_LIMIT)
export const PHOTO_DIM_LIMIT = 90;
export const PHOTO_LONG_EDGE = 1440; // about a phone screen's long side
export const PHOTO_JPEG_QUALITY = 0.8;
/** The analysis grid (columns × rows) a picked photo is shrunk to, one colour a patch. */
export const PHOTO_GRID = { width: 12, height: 24 } as const;

/** Which part of the photo stays in view when it's cropped to the screen: along the axis that's cut. */
export type PhotoFocus = 'start' | 'center' | 'end';
export const PHOTO_FOCI: readonly PhotoFocus[] = ['start', 'center', 'end'];

/** A kept photo: its file (the app's own copy) and what it looks like for contrast. */
export interface Photo {
  uri: string;
  width: number;
  height: number;
  /** '#RRGGBB': the mean first, then the brightest patches, then the darkest (photoTones). */
  tones: string[];
}

/** The background when it's a photo, with how it's shown. */
export interface PhotoBackground {
  kind: 'photo';
  uri: string; // one of Appearance.photos
  blur: number; // 0..PHOTO_BLUR_MAX
  dim: number; // percent, 0..PHOTO_DIM_MAX (black over the photo)
  focus: PhotoFocus;
  tint: boolean; // a wash of the theme's glow colour over it
}

export type PhotoAdjust = Omit<PhotoBackground, 'kind' | 'uri'>;
export const DEFAULT_PHOTO_ADJUST: PhotoAdjust = { blur: 4, dim: 35, focus: 'center', tint: false };

const BRIGHTEST = 6;
const DARKEST = 3;
/** Unknown colours (the grid couldn't be read): assume the worst, a white picture, so it's dimmed enough. */
export const UNKNOWN_TONES: readonly string[] = ['#FFFFFF'];

/** The colours of a photo's grid that matter for text: the mean, the brightest and the darkest patches. */
export function photoTones(pixels: readonly Rgb[]): string[] {
  if (!pixels.length) return [...UNKNOWN_TONES];
  const sum = pixels.reduce<[number, number, number]>((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]);
  const mean = hexOf([sum[0] / pixels.length, sum[1] / pixels.length, sum[2] / pixels.length]);
  const byLight = pixels.map((p) => ({ hex: hexOf(p), l: luminance(p) })).sort((a, b) => b.l - a.l);
  const picked = [...byLight.slice(0, BRIGHTEST), ...byLight.slice(-DARKEST)].map((x) => x.hex);
  return [mean, ...new Set(picked.filter((h) => h !== mean))];
}

/** Where the photo goes in a box so it covers it, the cut axis kept at `focus`. */
export function coverRect(boxW: number, boxH: number, imgW: number, imgH: number, focus: PhotoFocus): { left: number; top: number; width: number; height: number } {
  const scale = Math.max(boxW / imgW, boxH / imgH);
  const width = imgW * scale;
  const height = imgH * scale;
  const at = (spare: number) => (focus === 'start' ? 0 : focus === 'end' ? spare : spare / 2);
  return { left: at(boxW - width), top: at(boxH - height), width, height };
}

/** Which way a photo is cut on a screen of this shape: its sides (a wide photo) or its top and bottom. */
export function cutAxis(boxW: number, boxH: number, imgW: number, imgH: number): 'horizontal' | 'vertical' {
  return imgW / imgH > boxW / boxH ? 'horizontal' : 'vertical';
}

const clampInt = (v: unknown, most: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(most, Math.max(0, v))) : fallback);

/** Stored photos, made valid: whole entries only, no repeats, at most MAX_PHOTOS. */
export function normalizePhotos(v: unknown): Photo[] {
  const out: Photo[] = [];
  for (const p of Array.isArray(v) ? v : []) {
    if (out.length === MAX_PHOTOS) break;
    const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const size = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;
    const tones = Array.isArray(o.tones) ? o.tones.filter(isHex).slice(0, 1 + BRIGHTEST + DARKEST) : [];
    if (typeof o.uri !== 'string' || !o.uri || !size(o.width) || !size(o.height) || out.some((x) => x.uri === o.uri)) continue;
    out.push({ uri: o.uri, width: o.width as number, height: o.height as number, tones: tones.length ? tones : [...UNKNOWN_TONES] });
  }
  return out;
}

/** A stored photo background, made valid; null when it isn't one or its photo isn't kept. */
export function normalizePhotoBackground(v: unknown, photos: readonly Photo[]): PhotoBackground | null {
  const o = (v && typeof v === 'object' ? v : null) as Record<string, unknown> | null;
  if (!o || o.kind !== 'photo' || typeof o.uri !== 'string' || !photos.some((p) => p.uri === o.uri)) return null;
  const d = DEFAULT_PHOTO_ADJUST;
  return {
    kind: 'photo',
    uri: o.uri,
    blur: clampInt(o.blur, PHOTO_BLUR_MAX, d.blur),
    dim: clampInt(o.dim, PHOTO_DIM_MAX, d.dim),
    focus: PHOTO_FOCI.includes(o.focus as PhotoFocus) ? (o.focus as PhotoFocus) : d.focus,
    tint: typeof o.tint === 'boolean' ? o.tint : d.tint,
  };
}

export const isPhotoBackground = (b: unknown): b is PhotoBackground => !!b && typeof b === 'object' && (b as { kind?: unknown }).kind === 'photo';
