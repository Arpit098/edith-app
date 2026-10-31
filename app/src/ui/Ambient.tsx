// The app's backdrop, from the theme (Settings → Appearance): its background colour with the chosen
// look on top: the theme's two soft glows (as the app always had), plain, a sweep, a horizon, a faint
// dot or grid pattern, or a gradient (linear through expo-linear-gradient, radial through
// react-native-svg; no image assets). Every look stays dark enough for the chat's text
// (core/theme/themes.ts backdropSamples, tested).
//
// Static, drawn once per theme, except the "drift" gradients: their layer, a little larger than the
// screen, slides slowly back and forth on the native driver (no JS per frame, one view moving). It
// holds still with Android's "Remove animations", in thumbnails (a `look` passed in), and whenever
// real glass is drawn: every glass view blurs this backdrop, so a moving backdrop would make each one
// re-blur every frame (a steady GPU and battery cost). It drifts only while glass is flat (0%, battery
// saver, Android 11 and older), where nothing samples it.

import { LinearGradient } from 'expo-linear-gradient';
import { memo, useEffect, useId, useRef } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Path, Pattern, RadialGradient, Rect, Stop } from 'react-native-svg';

import { glassOn, hexOf, rgbaOf, rgbOf, useGlass, useTheme, type BackgroundLayer, type BackgroundLook, type GlassMode } from '../core/theme';

const CELL = { dots: 22, grid: 28 } as const; // pattern spacing, dp
const DRIFT_MS = 14_000; // one way; a full drift is twice this
const DRIFT_REACH = 0.08; // of the screen's width, each way

/** `look`: draw this one, still (a thumbnail); without it, the theme's own, drifting if it does. */
export const Ambient = memo(function Ambient({ look }: { look?: BackgroundLook }) {
  const theme = useTheme();
  const glass = useGlass();
  const bg = look ?? theme.background;
  const drift = bg.drift && !look && driftAllowed(glass.mode, theme.glass, glass.reduceMotion);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: bg.bg }]} pointerEvents="none" testID={`ambient-${bg.id}`}>
      {bg.layers.map((l, i) => (drift && i === 0 ? <Drifting key={i} layer={l} /> : <Layer key={i} layer={l} />))}
      {bg.pattern ? <PatternLayer kind={bg.pattern.kind} color={bg.pattern.color} /> : null}
    </View>
  );
});

/** Whether a drifting background may move: no "Remove animations", and no real glass sampling it. */
export function driftAllowed(mode: GlassMode, amount: number, reduceMotion: boolean): boolean {
  return !reduceMotion && (mode === 'flat' || !glassOn(amount));
}

function Layer({ layer: l }: { layer: BackgroundLayer }) {
  if (l.kind === 'radial') return <RadialLayer layer={l} />;
  return <LinearGradient colors={l.colors} start={l.start} end={l.end} style={StyleSheet.absoluteFill} />;
}

function RadialLayer({ layer: l }: { layer: Extract<BackgroundLayer, { kind: 'radial' }> }) {
  const id = `r${useId().replace(/[^a-zA-Z0-9]/g, '')}`; // unique per backdrop (thumbnails share a screen)
  const last = l.colors.length - 1;
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%" testID="ambient-radial">
      <Defs>
        <RadialGradient id={id} cx={`${l.center.x * 100}%`} cy={`${l.center.y * 100}%`} r={`${l.radius * 100}%`} gradientUnits="objectBoundingBox">
          {l.colors.map((c, i) => (
            <Stop key={i} offset={i / last} stopColor={hexOf(rgbOf(c))} stopOpacity={rgbaOf(c)[3]} />
          ))}
        </RadialGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

/** A layer a little larger than the screen, sliding slowly on a diagonal and back. */
function Drifting({ layer }: { layer: BackgroundLayer }) {
  const t = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const ease = Easing.inOut(Easing.sin);
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(t, { toValue: 1, duration: DRIFT_MS, easing: ease, useNativeDriver: true }),
        Animated.timing(t, { toValue: 0, duration: DRIFT_MS, easing: ease, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [t]);
  const reach = Dimensions.get('window').width * DRIFT_REACH;
  const transform = [
    { translateX: t.interpolate({ inputRange: [0, 1], outputRange: [-reach, reach] }) },
    { translateY: t.interpolate({ inputRange: [0, 1], outputRange: [reach, -reach] }) },
  ];
  return (
    <Animated.View style={[styles.oversized, { transform }]} testID="ambient-drift">
      <Layer layer={layer} />
    </Animated.View>
  );
}

function PatternLayer({ kind, color }: { kind: 'dots' | 'grid'; color: string }) {
  const s = CELL[kind];
  return (
    <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
      <Defs>
        <Pattern id={`bg-${kind}`} width={s} height={s} patternUnits="userSpaceOnUse">
          {kind === 'dots' ? <Circle cx={s / 2} cy={s / 2} r={1.3} fill={color} /> : <Path d={`M ${s} 0 L 0 0 0 ${s}`} stroke={color} strokeWidth={0.6} fill="none" />}
        </Pattern>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#bg-${kind})`} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  // Larger than the screen by more than the drift's reach, so no edge ever shows.
  oversized: { position: 'absolute', top: '-20%', left: '-20%', width: '140%', height: '140%' },
});
