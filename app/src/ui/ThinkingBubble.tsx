// The thinking orb: a Siri-style orb in the app icon's colours (tokens `orb`). Arpit, 31 Oct: "like
// the new Siri bubble, which is not transparent from inside". So it's opaque, built from the back:
//   - a gentle blue glow round it;
//   - the body: deep indigo at the edge, the logo's blue in the middle;
//   - inside it, clipped to the sphere: four soft colour blobs (violet, blue, lavender, icy cyan), each
//     a circle fading out from its centre so they blend like blurred paint, then three ribbons of light;
//   - the edge falling into shadow, a glossy highlight at the top-left and a soft-lit edge (gradients
//     fading in from the edge, not a stroke).
// While EDITH works, the blobs drift and the ribbons swirl and fold (ui/orbShape), and the glow and
// lit edge breathe. Each moving part is an animated prop computed in a worklet from one phase, so nothing
// renders in React per frame: one UI-thread loop, cancelled when it goes idle or unmounts. Idle, or
// with "Remove animations" on, it's one still frame of the same orb.
// SVG filters (blur) aren't dependable on Android, so softness comes from gradients, not filters.

import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedProps, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import Svg, { Circle, ClipPath, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';

import { motion, orb, stopOf } from '../core/theme';
import { BLOBS, blobAt, breath, glossOf, RIBBONS, ribbonPath, type BlobSpec, type RibbonSpec } from './orbShape';
import { useReduceMotion } from './motion';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

const STILL = 0.08; // the phase of the still frame: the ribbons crossing, the colours well spread
const VIEW = 100; // the SVG's own units; `size` scales it
const C = VIEW / 2;
const R = VIEW * 0.4; // the sphere; the rest is room for the glow
const GLOW_R = VIEW / 2;
const RIM_SHIFT = R * 0.16; // how far each edge light's centre sits off the orb's, so it lights one side

const gloss = glossOf(C, R); // still, computed once
const glossStop = stopOf(orb.gloss);
const glow = stopOf(orb.glow);
const shade = stopOf(orb.shade);
const rimLit = stopOf(orb.rimLit);
const rimMid = stopOf(orb.rimMid);
const rimFar = stopOf(orb.rimFar);
const blobStops = orb.blobs.map(stopOf);
const ribbonStops = orb.ribbons.map(stopOf);

export const ThinkingBubble = memo(function ThinkingBubble({ active, size = 24 }: { active: boolean; size?: number }) {
  const reduce = useReduceMotion();
  const t = useSharedValue(STILL);
  const moving = active && !reduce;
  useEffect(() => {
    if (!moving) {
      cancelAnimation(t);
      t.value = STILL;
      return;
    }
    // From the still frame on, a whole cycle at a time: each repeat starts where the last one ended.
    t.value = withRepeat(withTiming(STILL + 1, { duration: motion.orbMs, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [moving, t]);

  const glowProps = useAnimatedProps(() => ({ opacity: 0.78 + 0.22 * breath(t.value) }));
  const rimProps = useAnimatedProps(() => {
    const b = breath(t.value);
    return { opacity: 0.7 + 0.3 * b };
  });

  return (
    <View style={{ width: size, height: size }} accessible={false} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="tb-glow" cx={C} cy={C} r={GLOW_R} gradientUnits="userSpaceOnUse">
            <Stop offset={R / GLOW_R - 0.04} stopColor={glow.color} stopOpacity={glow.opacity} />
            <Stop offset="1" stopColor={glow.color} stopOpacity={0} />
          </RadialGradient>
          {/* Lit from the top-left: the middle sits a little up and left. */}
          <RadialGradient id="tb-body" cx="0.44" cy="0.42" r="0.6">
            <Stop offset="0" stopColor={orb.centre} />
            <Stop offset="0.55" stopColor={orb.mid} />
            <Stop offset="1" stopColor={orb.edge} />
          </RadialGradient>
          {blobStops.map((s, i) => (
            <RadialGradient key={i} id={`tb-blob${i}`} cx="0.5" cy="0.5" r="0.5">
              <Stop offset="0" stopColor={s.color} stopOpacity={s.opacity} />
              <Stop offset="0.5" stopColor={s.color} stopOpacity={s.opacity * 0.6} />
              <Stop offset="1" stopColor={s.color} stopOpacity={0} />
            </RadialGradient>
          ))}
          {ribbonStops.map((s, i) => (
            <LinearGradient key={i} id={`tb-ribbon${i}`} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={s.color} stopOpacity={s.opacity * 0.1} />
              <Stop offset="0.5" stopColor={s.color} stopOpacity={s.opacity} />
              <Stop offset="1" stopColor={s.color} stopOpacity={s.opacity * 0.1} />
            </LinearGradient>
          ))}
          <RadialGradient id="tb-shade" cx={C} cy={C} r={R} gradientUnits="userSpaceOnUse">
            <Stop offset="0.68" stopColor={shade.color} stopOpacity={0} />
            <Stop offset="1" stopColor={shade.color} stopOpacity={shade.opacity} />
          </RadialGradient>
          <RadialGradient id="tb-gloss" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor={glossStop.color} stopOpacity={glossStop.opacity} />
            <Stop offset="0.45" stopColor={glossStop.color} stopOpacity={glossStop.opacity * 0.4} />
            <Stop offset="1" stopColor={glossStop.color} stopOpacity={0} />
          </RadialGradient>
          {/* The soft-lit edge: no stroke, a highlight fading in towards the inside of the edge. Each
              gradient's centre sits off the orb's, towards the far side, so it lights one side most:
              the top-left (light) and a cyan bounce at the bottom-right; a faint even falloff joins them. */}
          <RadialGradient id="tb-rim" cx={C} cy={C} r={R} gradientUnits="userSpaceOnUse">
            <Stop offset="0.82" stopColor={rimMid.color} stopOpacity={0} />
            <Stop offset="1" stopColor={rimMid.color} stopOpacity={rimMid.opacity} />
          </RadialGradient>
          <RadialGradient id="tb-rim-lit" cx={C + RIM_SHIFT} cy={C + RIM_SHIFT} r={R + RIM_SHIFT} gradientUnits="userSpaceOnUse">
            <Stop offset="0.8" stopColor={rimLit.color} stopOpacity={0} />
            <Stop offset="1" stopColor={rimLit.color} stopOpacity={rimLit.opacity} />
          </RadialGradient>
          <RadialGradient id="tb-rim-far" cx={C - RIM_SHIFT} cy={C - RIM_SHIFT} r={R + RIM_SHIFT} gradientUnits="userSpaceOnUse">
            <Stop offset="0.84" stopColor={rimFar.color} stopOpacity={0} />
            <Stop offset="1" stopColor={rimFar.color} stopOpacity={rimFar.opacity} />
          </RadialGradient>
          <ClipPath id="tb-clip">
            <Circle cx={C} cy={C} r={R} />
          </ClipPath>
        </Defs>
        <AnimatedCircle animatedProps={glowProps} cx={C} cy={C} r={GLOW_R} fill="url(#tb-glow)" />
        <Circle cx={C} cy={C} r={R} fill="url(#tb-body)" />
        <G clipPath="url(#tb-clip)">
          {BLOBS.map((b, i) => (
            <Blob key={i} spec={b} fill={`url(#tb-blob${i})`} t={t} />
          ))}
          {RIBBONS.map((rb, i) => (
            <Ribbon key={i} spec={rb} fill={`url(#tb-ribbon${i})`} t={t} />
          ))}
        </G>
        <Circle cx={C} cy={C} r={R} fill="url(#tb-shade)" />
        <Ellipse cx={gloss.cx} cy={gloss.cy} rx={gloss.rx} ry={gloss.ry} fill="url(#tb-gloss)" transform={`rotate(${gloss.rotate} ${gloss.cx} ${gloss.cy})`} />
        <Circle cx={C} cy={C} r={R} fill="url(#tb-rim)" />
        <AnimatedCircle animatedProps={rimProps} cx={C} cy={C} r={R} fill="url(#tb-rim-lit)" />
        <AnimatedCircle animatedProps={rimProps} cx={C} cy={C} r={R} fill="url(#tb-rim-far)" />
      </Svg>
    </View>
  );
});

function Blob({ spec, fill, t }: { spec: BlobSpec; fill: string; t: SharedValue<number> }) {
  const props = useAnimatedProps(() => blobAt(spec, C, R, t.value));
  return <AnimatedCircle animatedProps={props} fill={fill} />;
}

function Ribbon({ spec, fill, t }: { spec: RibbonSpec; fill: string; t: SharedValue<number> }) {
  const props = useAnimatedProps(() => ({ d: ribbonPath(spec, C, R, t.value) }));
  return <AnimatedPath animatedProps={props} fill={fill} />;
}
