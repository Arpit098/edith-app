// The app's backdrop, from the theme (Settings → Appearance): its background colour with the chosen
// look on top: the theme's two soft glows (as the app always had), plain, a sweep, a horizon, or a
// faint dot or grid pattern drawn in code (react-native-svg; no image assets). Static: drawn once
// per theme, no animation, no cost while scrolling. Every look stays dark enough for the chat's
// text (core/theme/themes.ts backdropSamples, tested).

import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, Path, Pattern, Rect } from 'react-native-svg';

import { useTheme, type BackgroundLook } from '../core/theme';

const CELL = { dots: 22, grid: 28 } as const; // pattern spacing, dp

export const Ambient = memo(function Ambient({ look }: { look?: BackgroundLook }) {
  const theme = useTheme();
  const bg = look ?? theme.background;
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: bg.bg }]} pointerEvents="none" testID={`ambient-${bg.id}`}>
      {bg.layers.map((l, i) => (
        <LinearGradient key={i} colors={l.colors} start={l.start} end={l.end} style={StyleSheet.absoluteFill} />
      ))}
      {bg.pattern ? <PatternLayer kind={bg.pattern.kind} color={bg.pattern.color} /> : null}
    </View>
  );
});

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
