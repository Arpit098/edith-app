// One transcript row. Memoized: the reducer keeps unchanged items as the same objects, so a new
// event re-renders only the rows it touched.

import { memo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { DiffView } from '../../ui/DiffView';
import { Icon } from '../../ui/Icon';
import { ReplyButtons } from '../../ui/ReplyButtons';
import { StatusTick } from '../../ui/StatusTick';
import { colors, mono, radius, space } from '../../ui/theme';
import { clockIST } from '../../common/format';
import type { SentAttachment } from './attachments';
import type { Item, SendStatus, Tick } from './model';

const ORIGIN_LABEL: Record<string, string> = { telegram: 'Telegram', terminal: 'Terminal', app: '', system: '' };

/** Accessibility labels for the status ticks (drawn by ui/StatusTick). */
const TICK_LABEL: Record<Tick, string> = { clock: 'Not sent yet', sent: 'Sent', delivered: 'EDITH has it', failed: 'Not sent' };

/** A caption only where the state isn't obvious from the ticks. */
const STATUS_TEXT: Partial<Record<SendStatus, string>> = {
  queued: 'Queued: EDITH is busy, it runs next',
  side: 'Answering in parallel (the main conversation is busy)',
  folded: 'Added to the task EDITH was already working on',
  stopped: 'Stopped',
};

export interface ItemViewProps {
  item: Item;
  onPress: (id: number, action: string) => Promise<unknown>;
  tick?: Tick | null; // for Arpit's messages
  status?: SendStatus | null;
  onRetry?: (key: string) => void;
}

export const ItemView = memo(function ItemView({ item, onPress, tick, status, onRetry }: ItemViewProps) {
  switch (item.kind) {
    case 'user': {
      const from = ORIGIN_LABEL[item.origin];
      const failed = tick === 'failed';
      const retry = failed && item.local && !item.local.final && onRetry ? () => onRetry(item.local!.key) : undefined;
      const caption = failed ? (item.local?.error ?? 'Not sent') : status ? STATUS_TEXT[status] : undefined;
      return (
        <View style={styles.userWrap}>
          <Pressable style={[styles.bubble, styles.user, failed && styles.userFailed]} onPress={retry} disabled={!retry} accessibilityHint={retry ? 'Send again' : undefined}>
            {from || item.voice ? <Text style={styles.meta}>{[from, item.voice ? '🎙 voice' : ''].filter(Boolean).join(' · ')}</Text> : null}
            {item.attachments.length ? <SentAttachments list={item.attachments} /> : null}
            {item.text ? (
              <Text style={styles.text} selectable>
                {item.text}
              </Text>
            ) : null}
            <View style={styles.footer}>
              <Text style={styles.time}>{clockIST(item.ts)}</Text>
              {tick ? (
                <View accessibilityLabel={TICK_LABEL[tick]}>
                  <StatusTick kind={tick} color={colors.textDim} />
                </View>
              ) : null}
            </View>
          </Pressable>
          {item.reaction ? (
            <View style={styles.reaction} accessibilityLabel={`EDITH reacted ${item.reaction}`}>
              <Text style={styles.reactionText}>{item.reaction}</Text>
            </View>
          ) : null}
          {caption ? <Text style={[styles.caption, failed && styles.captionError]}>{retry ? `${caption} · Tap to retry` : caption}</Text> : null}
        </View>
      );
    }
    case 'assistant':
      return (
        <View style={[styles.bubble, styles.assistant]}>
          {item.lane === 'side' ? <Text style={styles.meta}>⚡ Parallel answer (the main conversation was busy)</Text> : null}
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

/** A message's attachments: thumbnails for images sent from this phone, name chips otherwise. */
const SentAttachments = memo(function SentAttachments({ list }: { list: SentAttachment[] }) {
  // A thumbnail whose file is gone (pruned, or the cache was cleared) shows as its name chip.
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <View style={styles.attachments}>
      {list.map((a, i) =>
        a.kind === 'image' && a.uri && !missing.has(a.uri) ? (
          <Image
            key={`${a.id}-${i}`}
            source={{ uri: a.uri }}
            style={styles.attachmentImage}
            accessibilityLabel={`Photo ${a.name}`}
            onError={() => setMissing((m) => new Set(m).add(a.uri!))}
          />
        ) : (
          <View key={`${a.id}-${i}`} style={styles.attachmentChip}>
            <Icon name={a.kind === 'audio' ? 'music-note-outline' : 'image-outline'} size={14} color={colors.textDim} />
            <Text style={styles.attachmentName} numberOfLines={1}>
              {a.name}
            </Text>
          </View>
        ),
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  attachments: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginBottom: space.xs },
  attachmentImage: { width: 140, height: 140, borderRadius: radius.m },
  attachmentChip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: 220, backgroundColor: colors.surfaceHigh, borderRadius: radius.s, paddingHorizontal: space.s, paddingVertical: space.xs },
  attachmentName: { color: colors.text, fontSize: 13, flexShrink: 1 },
  bubble: { borderRadius: radius.l, paddingHorizontal: space.m, paddingVertical: space.s + 2, marginVertical: space.xs, maxWidth: '88%' },
  userWrap: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '88%', marginVertical: space.xs },
  user: { backgroundColor: colors.user, borderBottomRightRadius: radius.s, maxWidth: '100%', marginVertical: 0 },
  userFailed: { borderWidth: 1, borderColor: colors.danger },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 2 },
  time: { color: colors.textDim, fontSize: 11 },
  reaction: { marginTop: -10, marginRight: space.s, backgroundColor: colors.surfaceHigh, borderRadius: 12, paddingHorizontal: 5, paddingVertical: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  reactionText: { fontSize: 14 },
  caption: { color: colors.textDim, fontSize: 11, marginTop: 2, marginRight: space.xs },
  captionError: { color: colors.danger },
  assistant: { backgroundColor: colors.surface, alignSelf: 'flex-start', borderBottomLeftRadius: radius.s },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  meta: { color: colors.textDim, fontSize: 11, marginBottom: 2 },
  note: { color: colors.textDim, fontSize: 13, marginTop: space.xs },
  system: { backgroundColor: colors.surfaceHigh, borderRadius: radius.m, padding: space.m, marginVertical: space.xs, borderLeftWidth: 3, borderLeftColor: colors.accent },
  systemError: { borderLeftColor: colors.danger },
  tool: { backgroundColor: colors.surface, borderRadius: radius.m, padding: space.s, marginVertical: 2, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  toolRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  toolName: { color: colors.text, fontFamily: mono, fontSize: 13, fontWeight: '700' },
  toolSummary: { color: colors.textDim, fontFamily: mono, fontSize: 13, flex: 1 },
  toolResult: { color: colors.text, fontFamily: mono, fontSize: 12, marginTop: space.s },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.s, marginVertical: space.m },
  rule: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  dividerText: { color: colors.textDim, fontSize: 12, maxWidth: '70%' },
});
