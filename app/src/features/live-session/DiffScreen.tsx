// A file's edits in a turn, full screen (Work card → a file row): its short path and +N −M in the
// header, then each edit's diff with lines wrapped (nothing cut off on the right), red and green
// line backgrounds, hunk headers dimmed, and the ---/+++ headers (long absolute paths) left out.
// Lines are a virtualised list: a long diff opens at once.

import { memo, useMemo } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, space, type, useTheme } from '../../core/theme';
import { Icon } from '../../ui/Icon';
import { readableDiff, type FileEdit } from './work';

type Line = { key: string; text: string; tone: 'add' | 'del' | 'hunk' | 'ctx' | 'gap' };

function toneOf(line: string): Line['tone'] {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

/** Every edit's lines, one after another (a gap row between edits). */
export function diffLines(file: FileEdit): Line[] {
  const out: Line[] = [];
  file.diffs.forEach((d, i) => {
    if (i > 0) out.push({ key: `gap-${i}`, text: `Edit ${i + 1}`, tone: 'gap' });
    readableDiff(d).forEach((text, j) => out.push({ key: `${i}-${j}`, text, tone: toneOf(text) }));
  });
  return out;
}

export const DiffScreen = memo(function DiffScreen({ file, onClose }: { file: FileEdit; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { bg } = useTheme();
  const lines = useMemo(() => diffLines(file), [file]);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.screen, { backgroundColor: bg, paddingTop: insets.top, paddingBottom: insets.bottom }]} accessibilityViewIsModal testID="diff-screen">
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={styles.close}>
            <Icon name="arrow-left" size={22} />
          </Pressable>
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={1}>
              {file.name}
            </Text>
            <Text style={styles.path} numberOfLines={1} ellipsizeMode="head">
              {file.where}
            </Text>
          </View>
          <Counts added={file.added} removed={file.removed} />
        </View>
        <FlatList
          data={lines}
          keyExtractor={(l) => l.key}
          renderItem={({ item }) => <DiffLine line={item} />}
          initialNumToRender={40}
          contentContainerStyle={styles.lines}
        />
      </View>
    </Modal>
  );
});

const DiffLine = memo(function DiffLine({ line }: { line: Line }) {
  return (
    <Text style={[styles.line, TONE[line.tone]]} selectable>
      {line.text || ' '}
    </Text>
  );
});

/** "+12 −3": green and red. */
export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <View style={styles.counts} accessibilityLabel={`${added} lines added, ${removed} removed`}>
      <Text style={styles.added}>+{added}</Text>
      <Text style={styles.removed}>−{removed}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.m, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  close: { padding: space.xs },
  titles: { flex: 1 },
  title: { color: colors.text, fontSize: type.size.body, fontWeight: '700' },
  path: { color: colors.textDim, fontSize: type.size.caption },
  lines: { paddingVertical: space.s },
  line: { fontFamily: type.mono, fontSize: 12, lineHeight: 18, paddingHorizontal: space.m, color: colors.text },
  counts: { flexDirection: 'row', gap: space.xs, paddingHorizontal: space.s, paddingVertical: 2, borderRadius: radius.pill, backgroundColor: colors.card },
  added: { color: colors.diffAddText, fontSize: type.size.caption, fontFamily: type.mono },
  removed: { color: colors.diffDelText, fontSize: type.size.caption, fontFamily: type.mono },
});

const TONE = StyleSheet.create({
  add: { color: colors.diffAddText, backgroundColor: colors.diffAdd },
  del: { color: colors.diffDelText, backgroundColor: colors.diffDel },
  hunk: { color: colors.textFaint, marginTop: space.s },
  ctx: {},
  gap: { color: colors.textDim, fontFamily: undefined, fontWeight: '700', marginTop: space.m, paddingVertical: space.xs, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
});
