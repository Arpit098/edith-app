// The pieces Appearance's sections share: a collapsible section, a sub-heading, a picture tile, a
// colour or gradient swatch (its check mark black or white by contrast), and a row of choices.

import { memo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, inkOn, radius, space, type, useTheme } from '../../core/theme';
import { Gradient } from '../../ui/Gradient';
import { Icon } from '../../ui/Icon';

/** A section of the page: its header (name, current choice, chevron) opens and closes it. */
export function Section({ title, value, open, onToggle, children }: { title: string; value: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Pressable
        onPress={onToggle}
        style={styles.sectionHead}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${title}: ${value}`}
        accessibilityHint={open ? 'Closes this section' : 'Opens this section'}
      >
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.sectionValue} numberOfLines={1}>
          {value}
        </Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textDim} />
      </Pressable>
      {open ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

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

export const SWATCH = 30;
export const TILE = 64;

export const shared = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m },
  links: { flexDirection: 'row', flexWrap: 'wrap', gap: space.l, alignItems: 'center' },
  flex: { flex: 1 },
});

const styles = StyleSheet.create({
  section: { borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, backgroundColor: colors.card },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m, paddingVertical: space.m, minHeight: 48 },
  sectionTitle: { color: colors.text, fontSize: type.size.body, fontWeight: '600' },
  sectionValue: { flex: 1, color: colors.textDim, fontSize: type.size.small, textAlign: 'right' },
  sectionBody: { paddingHorizontal: space.m, paddingBottom: space.m, gap: space.s },
  heading: { color: colors.textDim, fontSize: type.size.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: space.s },
  hint: { color: colors.textDim, fontSize: type.size.small },
  tile: { width: TILE, alignItems: 'center', gap: space.xs },
  tileArt: { width: TILE, height: TILE, borderRadius: radius.m, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  tileName: { color: colors.textDim, fontSize: type.size.caption },
  on: { color: colors.text, fontWeight: '700' },
  ring: { padding: 2, borderRadius: (SWATCH + 8) / 2, borderWidth: 2, borderColor: 'transparent' },
  ringOn: { borderColor: colors.text },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  link: { alignSelf: 'flex-start', paddingVertical: space.xs },
  linkText: { fontSize: type.size.small, fontWeight: '600' },
});
