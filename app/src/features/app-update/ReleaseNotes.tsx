// What a new version brings: "New", "Fixes" (and "Changes") as short lists, with the technical
// details (commit subjects) collapsed.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AppRelease } from '../../core/api';
import { colors, space, useTheme } from '../../core/theme';
import { noteSections } from './model';

export function ReleaseNotes({ release }: { release: AppRelease }) {
  const { sections, details } = noteSections(release);
  const [open, setOpen] = useState(false);
  const { accent } = useTheme();
  if (!sections.length && !details.length) return null;
  return (
    <View style={styles.box}>
      {sections.map((s) => (
        <View key={s.title} style={styles.section}>
          <Text style={styles.title}>{s.title}</Text>
          {s.items.map((item, i) => (
            <View key={i} style={styles.item}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.text}>{item}</Text>
            </View>
          ))}
        </View>
      ))}
      {details.length ? (
        <View style={styles.section}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((o) => !o)} hitSlop={8}>
            <Text style={[styles.toggle, { color: accent }]}>{open ? '▾' : '▸'} Technical details</Text>
          </Pressable>
          {open ? details.map((d, i) => <Text key={i} style={styles.detail}>{d}</Text>) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.s },
  section: { gap: space.xs },
  title: { color: colors.text, fontSize: 14, fontWeight: '600' },
  item: { flexDirection: 'row', gap: space.s, paddingLeft: space.xs },
  bullet: { color: colors.textDim, fontSize: 14 },
  text: { color: colors.text, fontSize: 14, flexShrink: 1 },
  toggle: { fontSize: 13 },
  detail: { color: colors.textDim, fontSize: 12, paddingLeft: space.m },
});
