// One transcript row. Memoized: the reducer keeps unchanged items as the same objects, so a new
// event re-renders only the rows it touched.

import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DiffView } from '../../ui/DiffView';
import { Icon } from '../../ui/Icon';
import { ReplyButtons } from '../../ui/ReplyButtons';
import { colors, type, radius, space } from '../../core/theme';
import type { Item } from './model';

const ORIGIN_LABEL: Record<string, string> = { telegram: 'Telegram', terminal: 'Terminal', app: '', system: '' };

export const ItemView = memo(function ItemView({ item, onPress }: { item: Item; onPress: (id: number, action: string) => Promise<unknown> }) {
  switch (item.kind) {
    case 'user': {
      const from = ORIGIN_LABEL[item.origin];
      return (
        <View style={[styles.bubble, styles.user]}>
          {from || item.voice ? <Text style={styles.meta}>{[from, item.voice ? '🎙 voice' : ''].filter(Boolean).join(' · ')}</Text> : null}
          <Text style={styles.text} selectable>
            {item.text}
          </Text>
        </View>
      );
    }
    case 'assistant':
      return (
        <View style={[styles.bubble, styles.assistant]}>
          <Text style={styles.text} selectable>
            {item.text}
          </Text>
        </View>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'diff':
      return <DiffCard path={item.path} diff={item.diff} />;
    case 'system':
      return (
        <View style={[styles.system, item.tone === 'error' && styles.systemError]}>
          <Text style={styles.text} selectable>
            {item.text}
          </Text>
          {item.note ? <Text style={styles.note}>{item.note}</Text> : null}
          <ReplyButtons rows={item.buttons} onPress={(action) => onPress(item.id, action)} />
        </View>
      );
    case 'divider':
      return (
        <View style={styles.divider}>
          <View style={styles.rule} />
          <Text style={styles.dividerText} numberOfLines={1}>
            {item.text}
          </Text>
          <View style={styles.rule} />
        </View>
      );
  }
});

const STATUS_ICON = { running: 'progress-clock', ok: 'check-circle-outline', error: 'alert-circle-outline' } as const;
const STATUS_COLOR = { running: colors.warn, ok: colors.ok, error: colors.danger } as const;

function ToolCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <Pressable style={styles.tool} onPress={() => item.result && setOpen((o) => !o)} accessibilityRole="button">
      <View style={styles.toolRow}>
        <Icon name={STATUS_ICON[item.status]} size={16} color={STATUS_COLOR[item.status]} />
        <Text style={styles.toolName}>{item.name}</Text>
        <Text style={styles.toolSummary} numberOfLines={open ? undefined : 1}>
          {item.summary}
        </Text>
      </View>
      {open && item.result ? (
        <Text style={styles.toolResult} selectable>
          {item.result}
        </Text>
      ) : null}
    </Pressable>
  );
}

function DiffCard({ path, diff }: { path: string; diff: string }) {
  return (
    <View style={styles.tool}>
      <View style={styles.toolRow}>
        <Icon name="file-document-edit-outline" size={16} color={colors.accent} />
        <Text style={styles.toolSummary} numberOfLines={1} ellipsizeMode="head">
          {path}
        </Text>
      </View>
      <View style={{ marginTop: space.s }}>
        <DiffView diff={diff} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: { borderRadius: radius.l, paddingHorizontal: space.m, paddingVertical: space.s + 2, marginVertical: space.xs, maxWidth: '88%' },
  user: { backgroundColor: colors.userBubble, alignSelf: 'flex-end', borderBottomRightRadius: radius.s },
  assistant: { backgroundColor: colors.assistantBubble, alignSelf: 'flex-start', borderBottomLeftRadius: radius.s, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  text: { color: colors.text, fontSize: type.size.body, lineHeight: 21 },
  meta: { color: colors.textDim, fontSize: type.size.caption, marginBottom: 2 },
  note: { color: colors.textDim, fontSize: type.size.small, marginTop: space.xs },
  system: { backgroundColor: colors.cardRaised, borderRadius: radius.m, padding: space.m, marginVertical: space.xs, borderLeftWidth: 3, borderLeftColor: colors.accent },
  systemError: { borderLeftColor: colors.danger, backgroundColor: colors.dangerSoft },
  tool: { backgroundColor: colors.card, borderRadius: radius.m, padding: space.s, marginVertical: 2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  toolName: { color: colors.text, fontFamily: type.mono, fontSize: type.size.small, fontWeight: '700' },
  toolSummary: { color: colors.textDim, fontFamily: type.mono, fontSize: type.size.small, flex: 1 },
  toolResult: { color: colors.text, fontFamily: type.mono, fontSize: 12, marginTop: space.s },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.s, marginVertical: space.m },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline },
  dividerText: { color: colors.textDim, fontSize: type.size.caption, maxWidth: '70%' },
});
