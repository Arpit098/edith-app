// A plain linear gradient at an angle (0 = towards the top, clockwise): the swatches for gradient
// bubbles and the stops strip in Settings → Appearance. Features draw gradients only through ui/.

import { LinearGradient } from 'expo-linear-gradient';
import { memo, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import { anglePoints } from '../core/theme';

export const Gradient = memo(function Gradient({ colors, angle, style, children }: { colors: readonly string[]; angle: number; style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  const points = anglePoints(angle);
  const stops = (colors.length > 1 ? colors : [colors[0]!, colors[0]!]) as unknown as readonly [string, string, ...string[]];
  return (
    <LinearGradient colors={stops} start={points.start} end={points.end} style={style}>
      {children}
    </LinearGradient>
  );
});
