// The thinking bubble (Arpit's reference: an iridescent orb with swirling bands inside), in the app
// icon's colours (tokens `bubble`). Its rim wobbles in slow waves like a soap bubble and the bands
// inside turn. Drawn with react-native-svg; the paths are worklets (ui/bubbleShape) fed to the SVG
// as animated props, so while it moves nothing renders in React: one UI-thread loop, cancelled
// when it goes idle or unmounts. Idle, or with "Remove animations" on, it's one still frame.

import { memo, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { cancelAnimation, Easing, useAnimatedProps, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import Svg, { ClipPath, Defs, G, LinearGradient, Path, RadialGradient, Stop } from 'react-native-svg';

import { bubble, motion, stopOf } from '../core/theme';
import { bandPath, BANDS, rimPath } from './bubbleShape';
import { useReduceMotion } from './motion';

const AnimatedPath = Animated.createAnimatedComponent(Path);

const STILL = 0.18; // the phase of the still frame: the bands spread, the rim gently uneven
const AMP = 0.055; // the rim's wobble, as a share of the radius
const VIEW = 100; // the SVG's own units; `size` scales it
const C = VIEW / 2;
const R = VIEW * 0.4; // room around it for the wobble and the rim's stroke

const sheen = stopOf(bubble.sheen);
const core = stopOf(bubble.core);
const body = stopOf(bubble.body);
const BAND_COLOURS = [bubble.bandSilver, bubble.bandBlue, bubble.bandDeep].map(stopOf);

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

  const fill = useAnimatedProps(() => ({ d: rimPath(C, C, R, t.value, AMP) }));
  const rim = useAnimatedProps(() => ({ d: rimPath(C, C, R, t.value, AMP) }));
  const band0 = useAnimatedProps(() => ({ d: bandPath(C, C, R, t.value, 0) }));
  const band1 = useAnimatedProps(() => ({ d: bandPath(C, C, R, t.value, 1) }));
  const band2 = useAnimatedProps(() => ({ d: bandPath(C, C, R, t.value, 2) }));
  const bands = [band0, band1, band2];

  return (
    <View style={{ width: size, height: size }} accessible={false} importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox={`0 0 ${VIEW} ${VIEW}`} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="tb-body" cx="45%" cy="42%" r="55%">
            <Stop offset="0%" stopColor={core.color} stopOpacity={core.opacity} />
            <Stop offset="100%" stopColor={body.color} stopOpacity={body.opacity} />
          </RadialGradient>
          <LinearGradient id="tb-rim" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor={bubble.rimLit} />
            <Stop offset="35%" stopColor={bubble.rimMid} />
            <Stop offset="65%" stopColor={sheen.color} stopOpacity={sheen.opacity} />
            <Stop offset="100%" stopColor={bubble.rimDeep} />
          </LinearGradient>
          <ClipPath id="tb-inside">
            <Path d={rimPath(C, C, R * 0.97, STILL, 0)} />
          </ClipPath>
        </Defs>
        <AnimatedPath animatedProps={fill} fill="url(#tb-body)" />
        <G clipPath="url(#tb-inside)">
          {BANDS.map((b, i) => (
            <AnimatedPath
              key={i}
              animatedProps={bands[i]}
              fill="none"
              stroke={BAND_COLOURS[i]!.color}
              strokeOpacity={BAND_COLOURS[i]!.opacity}
              strokeWidth={4.5 + b.width * 8}
              strokeLinecap="round"
            />
          ))}
        </G>
        <AnimatedPath animatedProps={rim} fill="none" stroke="url(#tb-rim)" strokeWidth={6} />
      </Svg>
    </View>
  );
});
