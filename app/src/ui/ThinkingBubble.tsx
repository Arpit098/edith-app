// The thinking bubble: a soap bubble in the app icon's colours (tokens `bubble`). Arpit, 31 Oct:
// "it should look like bubble", not an orb with swirls. So, from the back:
//   - the body: see-through, with only a faint tint in the middle, brightening just inside the rim;
//   - a thin iridescent rim (silver at the top-left, blue, a lavender sheen, a deeper blue);
//   - a faint reflection arc along the inside of the bottom;
//   - one crisp curved glint at the top-left and a tiny one at the bottom-right.
// While EDITH works the rim wobbles in slow waves. The rim is a worklet path (ui/bubbleShape) fed to
// the SVG as an animated prop, so nothing renders in React per frame: one UI-thread loop, cancelled
// when it goes idle or unmounts. Idle, or with "Remove animations" on, it's one still frame.

import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedProps, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';

import { bubble, motion, stopOf } from '../core/theme';
import { bubbleHighlights, rimPath } from './bubbleShape';
import { useReduceMotion } from './motion';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const STILL = 0.18; // the phase of the still frame: the rim gently uneven
const AMP = 0.05; // the rim's wobble, as a share of the radius
const VIEW = 100; // the SVG's own units; `size` scales it
const C = VIEW / 2;
const R = VIEW * 0.42; // room around it for the wobble and the rim's stroke
const RIM_WIDTH = 4.5; // about 1 dp at 22–24 dp: a thin skin

const core = stopOf(bubble.core);
const body = stopOf(bubble.body);
const sheen = stopOf(bubble.sheen);
const glint = stopOf(bubble.glint);
const reflection = stopOf(bubble.reflection);
const LIGHT = bubbleHighlights(C, R); // the still parts, computed once

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

  const outline = useAnimatedProps(() => ({ d: rimPath(C, C, R, t.value, AMP) })); // the body and the rim: one path per frame

  return (
    <View style={{ width: size, height: size }} accessible={false} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} style={StyleSheet.absoluteFill}>
        <Defs>
          {/* In the SVG's own units, so the wobble doesn't stretch it: clear in the middle, the tint gathering at the edge. */}
          <RadialGradient id="tb-body" cx={C} cy={C} r={R} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor={core.color} stopOpacity={core.opacity} />
            <Stop offset="0.62" stopColor={core.color} stopOpacity={core.opacity} />
            <Stop offset="0.9" stopColor={body.color} stopOpacity={body.opacity * 0.6} />
            <Stop offset="1" stopColor={body.color} stopOpacity={body.opacity} />
          </RadialGradient>
          <LinearGradient id="tb-rim" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={bubble.rimLit} />
            <Stop offset="0.35" stopColor={bubble.rimMid} />
            <Stop offset="0.65" stopColor={sheen.color} stopOpacity={sheen.opacity} />
            <Stop offset="1" stopColor={bubble.rimDeep} />
          </LinearGradient>
        </Defs>
        <AnimatedPath animatedProps={outline} fill="url(#tb-body)" />
        <Path d={LIGHT.reflection} fill="none" stroke={reflection.color} strokeOpacity={reflection.opacity} strokeWidth={2} strokeLinecap="round" />
        <AnimatedPath animatedProps={outline} fill="none" stroke="url(#tb-rim)" strokeWidth={RIM_WIDTH} />
        <Path d={LIGHT.glint} fill={glint.color} fillOpacity={glint.opacity} />
        <Circle cx={LIGHT.spot.cx} cy={LIGHT.spot.cy} r={LIGHT.spot.r} fill={glint.color} fillOpacity={glint.opacity * 0.8} />
      </Svg>
    </View>
  );
});
