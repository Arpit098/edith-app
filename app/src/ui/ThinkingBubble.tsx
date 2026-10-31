// The thinking bubble: a soap bubble at icon size (Arpit, 31 Oct: "it should look like a bubble"),
// in the app icon's colours (tokens `bubble`). From the inside out:
// - the film: almost clear in the middle, a faint tint that deepens only near the edge;
// - the rim: thin, its colour shifting round the bubble (silver, blue, lavender, deep blue) and
//   brighter towards the outside: a soft inner stroke under a crisp outer one;
// - the highlights: a crisp curved glint at the top-left, a tiny one at the bottom-right and a faint
//   inner reflection arc.
// While EDITH works the rim wobbles in slow waves. The rim's path is a worklet (ui/bubbleShape) fed
// to the SVG as an animated prop, so nothing renders in React per frame: one UI-thread loop,
// cancelled when it goes idle or unmounts. Idle, or with "Remove animations" on, it's one still frame.

import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedProps, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';

import { bubble, motion, stopOf } from '../core/theme';
import { arcPath, GLINTS, rimPath } from './bubbleShape';
import { useReduceMotion } from './motion';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const STILL = 0.18; // the phase of the still frame: the rim gently uneven
const AMP = 0.03; // the rim's wobble, as a share of the radius: a soap bubble stays nearly round
const VIEW = 100; // the SVG's own units; `size` scales it (24 dp: 1 unit ≈ 0.24 dp)
const C = VIEW / 2;
const R = VIEW * 0.42; // room around it for the wobble and the rim's stroke: 42·1.03 + 1.9 < 50
const INNER = 0.93; // the soft inner rim, as a share of R

const centre = stopOf(bubble.centre);
const inner = stopOf(bubble.inner);
const edge = stopOf(bubble.edge);
const sheen = stopOf(bubble.sheen);
const glint = stopOf(bubble.glint);
const reflection = stopOf(bubble.reflection);

// The highlights don't move: computed once.
const MAIN = arcPath(C, C, R * GLINTS.main.r, GLINTS.main.from, GLINTS.main.to);
const REFLECTION = arcPath(C, C, R * GLINTS.reflection.r, GLINTS.reflection.from, GLINTS.reflection.to);
const TINY = { cx: C + R * GLINTS.tiny.r * Math.cos(GLINTS.tiny.at), cy: C + R * GLINTS.tiny.r * Math.sin(GLINTS.tiny.at), r: R * GLINTS.tiny.size };

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
    t.value = withRepeat(withTiming(STILL + 1, { duration: motion.bubbleMs, easing: Easing.linear }), -1, false);
    return () => cancelAnimation(t);
  }, [moving, t]);

  const outline = useAnimatedProps(() => ({ d: rimPath(C, C, R, t.value, AMP) })); // the film and the crisp rim
  const innerRim = useAnimatedProps(() => ({ d: rimPath(C, C, R * INNER, t.value, AMP) }));

  return (
    <View style={{ width: size, height: size }} accessible={false} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} style={StyleSheet.absoluteFill}>
        <Defs>
          {/* The film: clear in the middle, the tint and the lavender only in the outer fifth. */}
          <RadialGradient id="tb-film" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={centre.color} stopOpacity={centre.opacity} />
            <Stop offset="62%" stopColor={centre.color} stopOpacity={centre.opacity} />
            <Stop offset="86%" stopColor={inner.color} stopOpacity={inner.opacity} />
            <Stop offset="100%" stopColor={edge.color} stopOpacity={edge.opacity} />
          </RadialGradient>
          {/* The rim's colour shift round the bubble: lit silver at the top-left, deep blue opposite. */}
          <LinearGradient id="tb-rim" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor={bubble.rimLit} />
            <Stop offset="30%" stopColor={bubble.rimMid} />
            <Stop offset="55%" stopColor={sheen.color} stopOpacity={sheen.opacity} />
            <Stop offset="78%" stopColor={bubble.rimMid} />
            <Stop offset="100%" stopColor={bubble.rimDeep} />
          </LinearGradient>
          {/* The inner rim runs the other way round, so the colour shifts across the rim's width too. */}
          <LinearGradient id="tb-rim-in" x1="100%" y1="0%" x2="0%" y2="100%">
            <Stop offset="0%" stopColor={sheen.color} stopOpacity={sheen.opacity} />
            <Stop offset="50%" stopColor={bubble.rimMid} />
            <Stop offset="100%" stopColor={bubble.rimDeep} />
          </LinearGradient>
        </Defs>
        <AnimatedPath animatedProps={outline} fill="url(#tb-film)" />
        <AnimatedPath animatedProps={innerRim} fill="none" stroke="url(#tb-rim-in)" strokeOpacity={0.45} strokeWidth={5} />
        <AnimatedPath animatedProps={outline} fill="none" stroke="url(#tb-rim)" strokeWidth={3.8} />
        <Path d={REFLECTION} fill="none" stroke={reflection.color} strokeOpacity={reflection.opacity} strokeWidth={3} strokeLinecap="round" />
        <Path d={MAIN} fill="none" stroke={glint.color} strokeOpacity={glint.opacity} strokeWidth={5} strokeLinecap="round" />
        <Circle cx={TINY.cx} cy={TINY.cy} r={TINY.r} fill={glint.color} fillOpacity={glint.opacity * 0.8} />
      </Svg>
    </View>
  );
});
