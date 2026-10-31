// Gradients for Settings → Appearance: the gradient backgrounds (presets and the ones built with
// "Custom…"), the gradient bubbles, and the accent colours. Pure data and colour maths; themes.ts
// turns them into the drawn background and the bubbles' glass, and tests their contrast.
//
// Readability is built in, not left to taste: every background stop is "tamed" to a luminance cap
// (its intensity sets the cap), so the app's text and dim text read at 4.5:1 or more directly on any
// gradient, at any intensity (tested over every preset and the builder's extremes).

import { luminance, type Rgb } from './contrast';
import { rgbaOf } from './tokens';

// ---- colour maths ----

const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const encoded = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const hex2 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');

export const isHex = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
export const hexOf = ([r, g, b]: Rgb): string => `#${hex2(r)}${hex2(g)}${hex2(b)}`.toUpperCase();

/** Hue 0..360, saturation and value 0..1 → '#RRGGBB' (the builder's hue and brightness sliders). */
export function hsvToHex(h: number, s: number, v: number): string {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return hexOf([r + m, g + m, b + m]);
}

/** '#RRGGBB' → hue 0..360, saturation and value 0..1. */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const [r, g, b] = rgbaOf(hex) as [number, number, number];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(((h * 60) % 360 + 360) % 360), s: max === 0 ? 0 : d / max, v: max };
}

/**
 * The most luminance a background stop may have: intensity 0 is near black, 100 the most that keeps
 * the app's dim text (62% white) at 4.5:1 on any hue (a saturated blue or magenta is the hardest).
 */
export const BACKGROUND_LUMINANCE = { least: 0.006, most: 0.03 } as const;

/** A background stop at an intensity (0..100): the colour, dimmed (hue kept) to that luminance cap at most. */
export function tame(hex: string, intensity: number): string {
  const cap = BACKGROUND_LUMINANCE.least + (BACKGROUND_LUMINANCE.most - BACKGROUND_LUMINANCE.least) * (Math.min(100, Math.max(0, intensity)) / 100);
  const c = rgbaOf(hex) as [number, number, number];
  const lum = luminance(c);
  if (lum <= cap) return hexOf(c);
  const k = cap / lum; // luminance is linear in linear light: scaling every channel by k scales it by k
  return hexOf(c.map((v) => encoded(linear(v) * k)) as unknown as Rgb);
}

// ---- gradient specs ----

export type GradientKind = 'linear' | 'radial';

/** A gradient as chosen: 2–4 stops, an angle (degrees, 0 = towards the top, clockwise), its kind and intensity. */
export interface GradientSpec {
  stops: string[]; // '#RRGGBB', 2..4
  angle: number; // 0..359; for radial, where the light comes from
  kind: GradientKind;
  intensity: number; // 0..100: how bright the stops may be (always dark enough for the text)
}

export interface CustomGradient extends GradientSpec {
  id: string; // 'custom-<n>'
}

export const MAX_STOPS = 4;
export const MAX_CUSTOM = 6;
export const DEFAULT_INTENSITY = 70;

/** The 8 directions the builder offers (and the angles a stored one is snapped to are free: 0..359). */
export const DIRECTIONS: readonly { angle: number; name: string; icon: string }[] = [
  { angle: 0, name: 'Up', icon: 'arrow-up' },
  { angle: 45, name: 'Up right', icon: 'arrow-top-right' },
  { angle: 90, name: 'Right', icon: 'arrow-right' },
  { angle: 135, name: 'Down right', icon: 'arrow-bottom-right' },
  { angle: 180, name: 'Down', icon: 'arrow-down' },
  { angle: 225, name: 'Down left', icon: 'arrow-bottom-left' },
  { angle: 270, name: 'Left', icon: 'arrow-left' },
  { angle: 315, name: 'Up left', icon: 'arrow-top-left' },
];

/** A linear gradient's start and end (0..1 boxes) for an angle: across the box's centre, corner to corner at 45°. */
export function anglePoints(angle: number): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const r = (angle * Math.PI) / 180;
  const [dx, dy] = [Math.sin(r), -Math.cos(r)];
  const half = 0.5 / Math.max(Math.abs(dx), Math.abs(dy)); // reach the box's edge, not fall short at the diagonals
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return {
    start: { x: round(0.5 - dx * half), y: round(0.5 - dy * half) },
    end: { x: round(0.5 + dx * half), y: round(0.5 + dy * half) },
  };
}

/** A radial gradient's centre for an angle: off-centre, on the side the light comes from. */
export function radialCenter(angle: number): { x: number; y: number } {
  const r = (angle * Math.PI) / 180;
  const round = (v: number) => Math.round(v * 1000) / 1000;
  return { x: round(0.5 - Math.sin(r) * 0.3), y: round(0.5 + Math.cos(r) * 0.3) };
}

/** A stored or partial gradient, made whole and valid; null when it can't be (fewer than 2 good stops). */
export function normalizeGradient(v: unknown): GradientSpec | null {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const stops = Array.isArray(o.stops) ? o.stops.filter(isHex).slice(0, MAX_STOPS).map((s) => s.toUpperCase()) : [];
  if (stops.length < 2) return null;
  const n = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return {
    stops,
    angle: ((Math.round(n(o.angle, 180)) % 360) + 360) % 360,
    kind: o.kind === 'radial' ? 'radial' : 'linear',
    intensity: Math.round(Math.min(100, Math.max(0, n(o.intensity, DEFAULT_INTENSITY)))),
  };
}

// ---- gradient backgrounds ----

export interface GradientBackground {
  id: string;
  name: string;
  spec: GradientSpec;
  drift?: boolean; // drifts slowly (one native-driven layer; off with "Remove animations")
}

const g = (stops: string[], angle: number, kind: GradientKind = 'linear', intensity = DEFAULT_INTENSITY): GradientSpec => ({ stops, angle, kind, intensity });

/** The gradient backgrounds, in their own colours (the theme still sets the accent). */
export const GRADIENT_BACKGROUNDS: readonly GradientBackground[] = [
  { id: 'sunset', name: 'Sunset', spec: g(['#FF7E5F', '#C44569', '#2C1E4A'], 180) },
  { id: 'borealis', name: 'Borealis', spec: g(['#00C9A7', '#2C73D2', '#845EC2'], 200) },
  { id: 'ocean-deep', name: 'Ocean deep', spec: g(['#3282B8', '#0F4C75', '#0B1A2E'], 180) },
  { id: 'neon', name: 'Neon', spec: g(['#FF00CC', '#3333FF'], 135, 'linear', 85) },
  { id: 'lavender', name: 'Lavender mist', spec: g(['#B79CED', '#6C5B9E', '#1E1830'], 315, 'radial') },
  { id: 'embers', name: 'Embers', spec: g(['#FF7A18', '#AF002D', '#1A0507'], 180, 'radial') },
  { id: 'mint', name: 'Mint', spec: g(['#3EECAC', '#1F8A70', '#0B2A22'], 45) },
  { id: 'cosmic', name: 'Cosmic', spec: g(['#E100FF', '#7F00FF', '#0B0320'], 30, 'radial', 80) },
  { id: 'peach', name: 'Peach', spec: g(['#FFB88C', '#DE6262'], 120, 'linear', 60) },
  { id: 'tropical', name: 'Tropical', spec: g(['#F9D423', '#FF4E50', '#2B5876', '#4E4376'], 160) },
  { id: 'royal', name: 'Royal', spec: g(['#6A82FB', '#243B55', '#141E30'], 90) },
  { id: 'moss', name: 'Moss', spec: g(['#56AB2F', '#1E3C1A', '#0A140A'], 0, 'radial') },
  { id: 'rose-gold', name: 'Rose gold', spec: g(['#E8CBC0', '#636FA4'], 160, 'linear', 55) },
  { id: 'slate', name: 'Slate', spec: g(['#606C88', '#3F4C6B', '#232526'], 180, 'linear', 60) },
  { id: 'aurora-drift', name: 'Aurora drift', spec: g(['#00C9A7', '#845EC2', '#2C73D2'], 210), drift: true },
  { id: 'nebula-drift', name: 'Nebula drift', spec: g(['#FF6FD8', '#3813C2', '#0B0320'], 330, 'radial'), drift: true },
];

// ---- gradient bubbles ----

/** A bubble's gradient: two stops and an angle. */
export interface BubbleGradient {
  stops: [string, string];
  angle: number;
}

export const BUBBLE_GRADIENTS: readonly { id: string; name: string; gradient: BubbleGradient }[] = [
  { id: 'grad-sunset', name: 'Sunset', gradient: { stops: ['#FF7E5F', '#C44569'], angle: 135 } },
  { id: 'grad-ocean', name: 'Ocean', gradient: { stops: ['#2E8BC0', '#3D5AD9'], angle: 135 } },
  { id: 'grad-aurora', name: 'Aurora', gradient: { stops: ['#22A699', '#6C5BD9'], angle: 135 } },
  { id: 'grad-neon', name: 'Neon', gradient: { stops: ['#E040FB', '#536DFE'], angle: 90 } },
  { id: 'grad-ember', name: 'Ember', gradient: { stops: ['#F2994A', '#E5536A'], angle: 135 } },
  { id: 'grad-mint', name: 'Mint', gradient: { stops: ['#4CAF50', '#22A699'], angle: 90 } },
  { id: 'grad-berry', name: 'Berry', gradient: { stops: ['#E07BC4', '#9B7CF0'], angle: 135 } },
  { id: 'grad-steel', name: 'Steel', gradient: { stops: ['#8A94A3', '#3D7FD9'], angle: 180 } },
];

export const CUSTOM_BUBBLE = 'custom'; // a side's bubble choice when it's that side's own gradient

export function normalizeBubbleGradient(v: unknown): BubbleGradient | null {
  const spec = normalizeGradient(v);
  return spec ? { stops: [spec.stops[0]!, spec.stops[1]!], angle: spec.angle } : null;
}

/** Where the builder starts for a new background gradient and a new bubble gradient. */
export const NEW_BACKGROUND_GRADIENT: GradientSpec = { stops: ['#9B7CF0', '#2E8BC0'], angle: 180, kind: 'linear', intensity: DEFAULT_INTENSITY };
export const NEW_BUBBLE_GRADIENT: BubbleGradient = { stops: ['#3D7FD9', '#9B7CF0'], angle: 135 };

// ---- accents ----

/** Accent colours that override the theme's: light enough to read as text on every background (tested). */
export const ACCENTS: readonly { id: string; name: string; color: string }[] = [
  { id: 'blue', name: 'Blue', color: '#7CAEDC' },
  { id: 'sky', name: 'Sky', color: '#5CC8E8' },
  { id: 'teal', name: 'Teal', color: '#4FD1C5' },
  { id: 'green', name: 'Green', color: '#8FD39C' },
  { id: 'lime', name: 'Lime', color: '#C5E86C' },
  { id: 'yellow', name: 'Yellow', color: '#F2C94C' },
  { id: 'orange', name: 'Orange', color: '#F5B070' },
  { id: 'red', name: 'Red', color: '#FF8A8A' },
  { id: 'pink', name: 'Pink', color: '#F2A0B8' },
  { id: 'purple', name: 'Purple', color: '#B9A3F5' },
  { id: 'grey', name: 'Grey', color: '#B9C2CF' },
];

/** The builder's palette: colours to pick a stop from (or use the hue and brightness sliders). */
export const STOP_PALETTE: readonly { name: string; color: string }[] = [
  { name: 'Coral', color: '#FF7E5F' },
  { name: 'Red', color: '#FF4E50' },
  { name: 'Rose', color: '#E5536A' },
  { name: 'Pink', color: '#E07BC4' },
  { name: 'Magenta', color: '#E100FF' },
  { name: 'Lilac', color: '#9B7CF0' },
  { name: 'Indigo', color: '#6C5BD9' },
  { name: 'Blue', color: '#3D7FD9' },
  { name: 'Ocean', color: '#2E8BC0' },
  { name: 'Sky', color: '#4FC3E8' },
  { name: 'Teal', color: '#22A699' },
  { name: 'Mint', color: '#3EECAC' },
  { name: 'Green', color: '#4CAF50' },
  { name: 'Lime', color: '#C5E86C' },
  { name: 'Yellow', color: '#F9D423' },
  { name: 'Orange', color: '#F2994A' },
  { name: 'Grey', color: '#8A94A3' },
  { name: 'Plum', color: '#2C1E4A' },
  { name: 'Navy', color: '#0B1A2E' },
  { name: 'Oxblood', color: '#1A0507' },
];
