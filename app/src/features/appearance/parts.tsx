// The pieces Appearance's tools share: a sub-heading, a hint, a picture tile, a
// colour or gradient swatch (its check mark black or white by contrast), and a row of choices.

import { memo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, inkOn, radius, space, type, useTheme } from '../../core/theme';
import { Gradient } from '../../ui/Gradient';
import { Icon } from '../../ui/Icon';

export function Heading({ children }: { children: string }) {
  return (
    <Text style={styles.heading} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <Text style={styles.hint}>{children}</Text>;
}

/** A picture tile (a theme, a background): `art` drawn in a rounded square, its name under it. */
export const Tile = memo(function Tile({ art, name, on, onPress, label, ring }: { art: ReactNode; name: string; on: boolean; onPress: () => void; label: string; ring?: string }) {
  return (
    <Pressable onPress={onPress} style={styles.tile} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={label}>
      <View style={[styles.tileArt, on && { borderColor: ring ?? colors.text, borderWidth: 2 }]}>{art}</View>
      <Text style={[styles.tileName, on && styles.on]} numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
  );
});

/** A round swatch: one colour, or a gradient's stops. `icon` replaces the check (e.g. "Theme default"). */
export const Swatch = memo(function Swatch({ colors: fill, angle = 135, on, onPress, label, icon }: { colors: readonly string[]; angle?: number; on: boolean; onPress: () => void; label: string; icon?: string }) {
  const { bg } = useTheme(); // what a translucent swatch sits on
  const mark = inkOn(fill, bg); // black on yellow, white on blue: best over all of a gradient's stops
  const glyph = icon ?? (on ? 'check' : null);
  return (
    <Pressable onPress={onPress} hitSlop={4} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={label} style={[styles.ring, on && styles.ringOn]}>
      {fill.length > 1 ? (
        <Gradient colors={fill} angle={angle} style={styles.swatch}>
          {glyph ? <Icon name={glyph} size={14} color={mark} /> : null}
        </Gradient>
      ) : (
        <View style={[styles.swatch, { backgroundColor: fill[0] }]}>{glyph ? <Icon name={glyph} size={14} color={mark} /> : null}</View>
      )}
    </Pressable>
  );
});

/** A small text button ("Custom…", "Edit", "Back to 60%"), in the accent. */
export function LinkButton({ label, onPress, a11y, disabled }: { label: string; onPress: () => void; a11y?: string; disabled?: boolean }) {
  const { accent } = useTheme();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={a11y ?? label} accessibilityState={{ disabled: !!disabled }} hitSlop={8} style={styles.link}>
      <Text style={[styles.linkText, { color: disabled ? colors.textFaint : accent }]}>{label}</Text>
    </Pressable>
  );
}

/** A slider row: an icon, the slider (it names itself to TalkBack), and its value for sighted users. */
export function Labelled({ icon, value, children }: { icon: string; value: string; children: ReactNode }) {
  return (
    <View style={styles.labelled}>
      <Icon name={icon} size={18} color={colors.textDim} />
      <View style={shared.flex}>{children}</View>
      <Text style={styles.value} accessibilityElementsHidden importantForAccessibility="no">
        {value}
      </Text>
    </View>
  );
}

/** One choice of a few, as a pill ("Linear", "Top"); in a `shared.segments` radiogroup. */
export function Segment({ label, a11y, on, onPress }: { label: string; a11y?: string; on: boolean; onPress: () => void }) {
  const { accentSoft } = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.segment, on && { backgroundColor: accentSoft, borderColor: colors.text }]} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={a11y ?? label}>
      <Text style={[styles.segmentText, on && styles.segmentOn]}>{label}</Text>
    </Pressable>
  );
}

export const SWATCH = 30;
export const TILE = 64;

export const shared = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  segments: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space.l, alignItems: 'center' },
  flex: { flex: 1 },
});

const styles = StyleSheet.create({
  heading: { color: colors.textDim, fontSize: type.size.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: space.s },
  hint: { color: colors.textDim, fontSize: type.size.small },
  tile: { width: TILE, alignItems: 'center', gap: space.xs },
  tileArt: { width: TILE, height: TILE, borderRadius: radius.m, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  tileName: { color: colors.textDim, fontSize: type.size.caption },
  on: { color: colors.text, fontWeight: '700' },
  ring: { padding: 2, borderRadius: (SWATCH + 8) / 2, borderWidth: 2, borderColor: 'transparent' },
  ringOn: { borderColor: colors.text },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  labelled: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  value: { color: colors.text, fontSize: type.size.small, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'right' },
  segment: { paddingHorizontal: space.l, paddingVertical: space.s, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  segmentText: { color: colors.textDim, fontSize: type.size.small },
  segmentOn: { color: colors.text, fontWeight: '700' },
  link: { alignSelf: 'flex-start', paddingVertical: space.xs },
  linkText: { fontSize: type.size.small, fontWeight: '600' },
});
