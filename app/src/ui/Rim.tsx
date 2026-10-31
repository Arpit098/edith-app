// The specular rim of a glass surface (Glass `rim`, tokens `rims`): light catching the glass edge,
// bright at the top-left and bottom-right corners and fading to nearly nothing along the other two.
//
// It's the usual glassmorphism recipe (a gradient stroke, an inner highlight, a faint inner shadow)
// drawn as one small SVG over the surface, so it's identical on real glass (the AGSL lens), blur
// only and the flat fallback. The gradients run along the bounding box's diagonal, so whatever the
// shape (a circle, a pill, a panel) its top-right and bottom-left corners are the dim ones. The SVG
// only redraws when the surface's size changes, never when it moves (the keyboard opening).

import { memo } from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { rims, stopOf, type RimStyle, type Scheme } from '../core/theme';

interface Stops {
  rim: { offset: string; color: string; opacity: number }[];
  shade: { color: string; opacity: number };
}

function stopsOf(r: RimStyle): Stops {
  const lit = stopOf(r.lit);
  const mid = stopOf(r.mid);
  const dim = stopOf(r.dim);
  return {
    rim: [
      { offset: '0%', ...lit },
      { offset: '22%', ...mid },
      { offset: '50%', ...dim },
      { offset: '78%', color: mid.color, opacity: mid.opacity * r.far },
      { offset: '100%', color: lit.color, opacity: lit.opacity * r.far },
    ],
    shade: stopOf(r.shade),
  };
}

const STOPS: Record<Scheme, Stops> = { dark: stopsOf(rims.dark), light: stopsOf(rims.light) };
const SHADE_WIDTH = 1; // the inner shadow: as thin as the rim it sits under

/** The rim's three strokes (outermost first), each centred on its rect: [inset, stroke width]. */
export function rimInsets(r: RimStyle): { rim: [number, number]; glow: [number, number]; shade: [number, number] } {
  return {
    rim: [r.width / 2, r.width],
    glow: [r.width + r.glowWidth / 2, r.glowWidth],
    shade: [r.width + SHADE_WIDTH / 2, SHADE_WIDTH],
  };
}

export interface RimProps {
  width: number;
  height: number;
  radius: number;
  scheme?: Scheme;
  /** How bright the rim is, 0..1 (the glass amount, theme `rim`); its width never changes. */
  strength?: number;
}

export const Rim = memo(function Rim({ width, height, radius, scheme = 'dark', strength = 1 }: RimProps) {
  if (width <= 0 || height <= 0 || strength <= 0) return null;
  const style = rims[scheme];
  const stops = STOPS[scheme];
  const corner = Math.min(radius, width / 2, height / 2);
  const ins = rimInsets(style);
  const rect = ([inset, stroke]: [number, number], paint: string, opacity = 1) => (
    <Rect
      x={inset}
      y={inset}
      width={Math.max(0, width - 2 * inset)}
      height={Math.max(0, height - 2 * inset)}
      rx={Math.max(0, corner - inset)}
      ry={Math.max(0, corner - inset)}
      fill="none"
      stroke={paint}
      strokeWidth={stroke}
      strokeOpacity={opacity}
    />
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
          <Stop offset="55%" stopColor={stops.shade.color} stopOpacity={0} />
          <Stop offset="100%" stopColor={stops.shade.color} stopOpacity={stops.shade.opacity} />
        </LinearGradient>
      </Defs>
      {rect(ins.shade, 'url(#shade)')}
      {rect(ins.glow, 'url(#rim)', style.glow)}
      {rect(ins.rim, 'url(#rim)')}
    </Svg>
  );
});
