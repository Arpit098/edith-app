// A one-line title filled with the theme's gradient (tokens `titleGradient`: blue → lavender → cyan,
// left to right) with the soft blue glow behind it (titleGlow's colour). Drawn with react-native-svg:
// the fill is a LinearGradient over the text's own box, and the glow is the same text stroked wide
// and faint underneath (two layers), so the glow and the letters always line up exactly and nothing
// is blurred at runtime. Static: it draws once, nothing per frame.

import { memo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Text as SvgText } from 'react-native-svg';

import { stopOf, titleGlow, titleGradient } from '../core/theme';

const glow = stopOf(titleGlow.textShadowColor);
// The halo: a wide faint stroke and a narrower, stronger one, like a soft text shadow with no offset.
const HALO = [
  { width: 7, opacity: glow.opacity * 0.16 },
  { width: 3.5, opacity: glow.opacity * 0.3 },
] as const;
const STOPS = titleGradient.map((color, i) => ({ color, offset: i / (titleGradient.length - 1) }));

export interface GradientTitleProps {
  text: string;
  fontSize: number;
  letterSpacing?: number;
  style?: StyleProp<ViewStyle>;
}

export const GradientTitle = memo(function GradientTitle({ text, fontSize, letterSpacing = 0, style }: GradientTitleProps) {
  const height = Math.ceil(fontSize * 1.6); // room for the glow above and below
  // The baseline: the capitals' middle on the box's middle (a cap is about 0.71 em tall in Roboto).
  const y = height / 2 + fontSize * 0.355;
  const common = { x: '50%', y, textAnchor: 'middle' as const, fontSize, fontWeight: '700' as const, letterSpacing };
  return (
    <View style={[styles.box, { height }, style]} accessible accessibilityRole="header" accessibilityLabel={text} pointerEvents="none">
      <Svg width="100%" height={height}>
        <Defs>
          <LinearGradient id="gt-fill" x1="0" y1="0" x2="1" y2="0">
            {STOPS.map((s) => (
              <Stop key={s.offset} offset={s.offset} stopColor={s.color} />
            ))}
          </LinearGradient>
        </Defs>
        {HALO.map((h) => (
          <SvgText key={h.width} {...common} fill="none" stroke={glow.color} strokeOpacity={h.opacity} strokeWidth={h.width} strokeLinejoin="round">
            {text}
          </SvgText>
        ))}
        <SvgText {...common} fill="url(#gt-fill)">
          {text}
        </SvgText>
      </Svg>
    </View>
  );
});

const styles = StyleSheet.create({ box: { justifyContent: 'center' } });
