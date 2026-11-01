// The specular rim of a glass surface (Glass `rim`, tokens `rims`; the chat bubbles' liquid glass):
// light catching the glass edge, bright at the top-left and bottom-right corners and fading towards
// the other two.
//
// It's the usual glassmorphism recipe (a gradient stroke, an inner highlight, a faint inner shadow)
// drawn as one small SVG over the surface, so it's identical on real glass (the AGSL lens), blur
// only and the flat fallback. The SVG only redraws when the surface's size changes, never when it
// moves (the keyboard opening).
//
// Placement: each stroke is the surface's own outline, inset by half its width (so it lies just
// inside the edge), with each corner's radius less that inset: concentric with the outline at every
// corner, a bubble's small tail corner included (`corners`). Nothing is clipped or offset.
//
// The fade: the gradient runs along the bounding box's diagonal in its own units, so it scales with
// the surface (a one-line bubble and a tall one fade alike). It isn't a few straight segments (whose
// kinks showed, and whose dim middle broke the line off at two corners): it's a smooth curve, sampled
// finely (RIM_SAMPLES), that eases from lit down to `dim` and back up to the far corner. `dim` is
// never zero, so the line thins away without ever ending.

import { memo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { rims, stopOf, type RimStyle, type Scheme } from '../core/theme';

interface RimStop {
  offset: string;
  color: string;
  opacity: number;
}

interface Stops {
  rim: RimStop[];
  shade: { color: string; opacity: number };
}

export const RIM_SAMPLES = 17; // stops along the diagonal: a smooth curve, not visible segments
const MID_AT = 0.22; // where `mid` sits on the curve (as the rim was first drawn)

/**
 * The rim's opacity along the diagonal, t 0..1: a raised cosine from the top-left (lit) to the
 * middle (dim) and on to the bottom-right (lit × far), shaped so it passes through `mid` at MID_AT.
 * Smooth everywhere (no kink, no flat cut), and never below `dim` × `far`; exactly `lit` at the
 * top-left and `lit` × `far` at the bottom-right.
 */
export function rimCurve(r: RimStyle): (t: number) => number {
  const lit = stopOf(r.lit).opacity;
  const mid = stopOf(r.mid).opacity;
  const dim = stopOf(r.dim).opacity;
  const bell = (t: number) => (1 + Math.cos(2 * Math.PI * t)) / 2; // 1 at the ends, 0 in the middle
  const shape = Math.log(Math.max(1e-3, (mid - dim) / Math.max(1e-3, lit - dim))) / Math.log(bell(MID_AT));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  // `far` scales the whole curve towards the bottom-right, so it ends at exactly lit × far there (as the rim always did).
  return (t) => (dim + (lit - dim) * bell(t) ** shape) * (1 + (r.far - 1) * smooth(t));
}

function stopsOf(r: RimStyle): Stops {
  const curve = rimCurve(r);
  const lit = stopOf(r.lit);
  const dim = stopOf(r.dim);
  return {
    rim: Array.from({ length: RIM_SAMPLES }, (_, i) => {
      const t = i / (RIM_SAMPLES - 1);
      return { offset: `${Math.round(t * 1000) / 10}%`, color: t > 0.4 && t < 0.6 ? dim.color : lit.color, opacity: Math.round(curve(t) * 1000) / 1000 };
    }),
    shade: stopOf(r.shade),
  };
}

const STOPS: Record<Scheme, Stops> = { dark: stopsOf(rims.dark), light: stopsOf(rims.light) };
const SHADE_WIDTH = 1; // the inner shadow: as thin as the rim it sits under

/** The rim's three strokes (outermost first), each centred on its outline: [inset, stroke width]. */
export function rimInsets(r: RimStyle): { rim: [number, number]; glow: [number, number]; shade: [number, number] } {
  return {
    rim: [r.width / 2, r.width],
    glow: [r.width + r.glowWidth / 2, r.glowWidth],
    shade: [r.width + SHADE_WIDTH / 2, SHADE_WIDTH],
  };
}

/** Each corner's radius (a bubble's tail corner is the small one). */
export interface Corners {
  tl: number;
  tr: number;
  br: number;
  bl: number;
}

/**
 * The outline of a w×h rounded rectangle inset by `inset`, as an SVG path: each corner's radius
 * clamped to fit (as the view draws it) and reduced by the inset, so the path is concentric with
 * the edge everywhere.
 */
export function insetOutline(w: number, h: number, corners: Corners, inset: number): string {
  const fit = Math.min(w / 2, h / 2);
  const r = (c: number) => Math.max(0, Math.min(c, fit) - inset);
  const [tl, tr, br, bl] = [r(corners.tl), r(corners.tr), r(corners.br), r(corners.bl)];
  const x0 = inset;
  const y0 = inset;
  const x1 = Math.max(x0, w - inset);
  const y1 = Math.max(y0, h - inset);
  const n = (v: number) => Math.round(v * 1000) / 1000;
  const arc = (rad: number, x: number, y: number) => (rad > 0 ? `A ${n(rad)} ${n(rad)} 0 0 1 ${n(x)} ${n(y)}` : `L ${n(x)} ${n(y)}`);
  return [
    `M ${n(x0 + tl)} ${n(y0)}`,
    `L ${n(x1 - tr)} ${n(y0)}`,
    arc(tr, x1, y0 + tr),
    `L ${n(x1)} ${n(y1 - br)}`,
    arc(br, x1 - br, y1),
    `L ${n(x0 + bl)} ${n(y1)}`,
    arc(bl, x0, y1 - bl),
    `L ${n(x0)} ${n(y0 + tl)}`,
    arc(tl, x0 + tl, y0),
    'Z',
  ].join(' ');
}

export interface RimProps {
  width: number;
  height: number;
  radius: number;
  /** Per-corner radii, when they differ (a chat bubble's tail); `radius` otherwise. */
  corners?: Corners;
  scheme?: Scheme;
  /** How bright the rim is, 0..1 (the glass amount, theme `rim`); its width never changes. */
  strength?: number;
}

export const Rim = memo(function Rim({ width, height, radius, corners, scheme = 'dark', strength = 1 }: RimProps) {
  if (width <= 0 || height <= 0 || strength <= 0) return null;
  const style = rims[scheme];
  const stops = STOPS[scheme];
  const shape = corners ?? { tl: radius, tr: radius, br: radius, bl: radius };
  const ins = rimInsets(style);
  const stroke = ([inset, w]: [number, number], paint: string, opacity = 1) => (
    <Path d={insetOutline(width, height, shape, inset)} fill="none" stroke={paint} strokeWidth={w} strokeOpacity={opacity} strokeLinejoin="round" />
  );
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} opacity={strength} pointerEvents="none" accessible={false} testID="glass-rim">
      <Defs>
        <LinearGradient id="rim" x1="0%" y1="0%" x2="100%" y2="100%">
          {stops.rim.map((s) => (
            <Stop key={s.offset} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />
          ))}
        </LinearGradient>
        <LinearGradient id="shade" x1="0%" y1="0%" x2="0%" y2="100%">
          {/* Eased in, so the inner shadow has no start line on the sides either. */}
          <Stop offset="45%" stopColor={stops.shade.color} stopOpacity={0} />
          <Stop offset="70%" stopColor={stops.shade.color} stopOpacity={stops.shade.opacity * 0.3} />
          <Stop offset="100%" stopColor={stops.shade.color} stopOpacity={stops.shade.opacity} />
        </LinearGradient>
      </Defs>
      {stroke(ins.shade, 'url(#shade)')}
      {stroke(ins.glow, 'url(#rim)', style.glow)}
      {stroke(ins.rim, 'url(#rim)')}
    </Svg>
  );
});
