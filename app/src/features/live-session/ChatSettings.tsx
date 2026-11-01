// Settings → Chat → Work details: how much of EDITH's work (the commands she runs, the files she
// edits) each turn's Work card shows.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useStore } from '../../core/store';
import { colors, radius, space, type, useTheme } from '../../core/theme';
import type { WorkDetailSetting } from './chatSettings';
import { WORK_DETAILS } from './work';

export function ChatSettings({ setting }: { setting: WorkDetailSetting }) {
  const chosen = useStore(setting.store, (d) => d);
  const { accentSoft } = useTheme();
  return (
    <View style={styles.page}>
      <Text style={styles.heading} accessibilityRole="header">
        Work details
      </Text>
      <View style={styles.options} accessibilityRole="radiogroup">
        {WORK_DETAILS.map((d) => {
          const on = d.id === chosen;
          return (
            <Pressable key={d.id} onPress={() => setting.set(d.id)} style={[styles.option, on && { backgroundColor: accentSoft, borderColor: colors.text }]} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`${d.name}: ${d.hint}`}>
              <Text style={[styles.name, on && styles.on]}>{d.name}</Text>
              <Text style={styles.hint}>{d.hint}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={styles.note}>A failed step always shows, whatever this is set to.</Text>
    </View>
  );
}

/** The Settings row's line: "Work details: Steps". */
export function chatSummary(name: string | undefined): string {
  return `Work details: ${name ?? 'Steps'}`;
}

const styles = StyleSheet.create({
  page: { gap: space.s },
  heading: { color: colors.textDim, fontSize: type.size.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  options: { gap: space.s },
  option: { padding: space.m, borderRadius: radius.m, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, backgroundColor: colors.card, gap: 2 },
  name: { color: colors.text, fontSize: type.size.body },
  on: { fontWeight: '700' },
  hint: { color: colors.textDim, fontSize: type.size.small },
  note: { color: colors.textDim, fontSize: type.size.small },
});
