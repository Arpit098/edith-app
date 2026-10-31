// A unified diff, coloured per line. Long diffs show the first lines until expanded.

import { memo, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, themedStyles, type, radius, space } from '../core/theme';

const PREVIEW_LINES = 14;

function lineStyle(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return styles.meta;
  if (line.startsWith('@@')) return styles.hunk;
  if (line.startsWith('+')) return styles.add;
  if (line.startsWith('-')) return styles.del;
  return styles.ctx;
}

export const DiffView = memo(function DiffView({ diff }: { diff: string }) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => diff.replace(/\n$/, '').split('\n'), [diff]);
  const shown = open ? lines : lines.slice(0, PREVIEW_LINES);
  const ts = useStyles();
  return (
    <View style={[styles.box, ts.box]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          {shown.map((line, i) => (
            <Text key={i} style={[styles.line, lineStyle(line)]} numberOfLines={1}>
              {line || ' '}
            </Text>
          ))}
        </View>
      </ScrollView>
      {lines.length > PREVIEW_LINES ? (
        <Pressable onPress={() => setOpen((o) => !o)} accessibilityRole="button" style={styles.more}>
          <Text style={[styles.moreText, ts.moreText]}>{open ? 'Show less' : `Show all ${lines.length} lines`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  box: { borderRadius: radius.s, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, overflow: 'hidden' },
  line: { fontFamily: type.mono, fontSize: 12, lineHeight: 17, paddingHorizontal: space.s },
  meta: { color: colors.textDim },
  hunk: { color: colors.diffHunk },
  add: { color: colors.diffAddText, backgroundColor: colors.diffAdd },
  del: { color: colors.diffDelText, backgroundColor: colors.diffDel },
  ctx: { color: colors.text },
  more: { padding: space.s, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  moreText: { fontSize: 13, textAlign: 'center' },
});

const useStyles = themedStyles((t) => StyleSheet.create({ box: { backgroundColor: t.bg }, moreText: { color: t.accent } }));
