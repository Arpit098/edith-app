// One transcript row. Memoized: the reducer keeps unchanged items as the same objects, so a new
// event re-renders only the rows it touched.

import { memo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { DiffView } from '../../ui/DiffView';
import { Icon } from '../../ui/Icon';
import { ReplyButtons } from '../../ui/ReplyButtons';
import { StatusTick } from '../../ui/StatusTick';
import { colors, type, radius, space } from '../../core/theme';
import { clockIST } from '../../common/format';
import type { SentAttachment } from './attachments';
import type { Item, SendStatus, Tick } from './model';
import type { Quote } from './reply';

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
  /** Quote this message in the composer (TalkBack's "Reply" action; sighted users swipe the row). */
  onReply?: (item: Item) => void;
  /** The quote on a reply was tapped: scroll to the message it quotes. */
  onQuote?: (itemId: number, quote: string) => void;
  /** Briefly marked: the message a tapped quote jumped to. */
  highlight?: boolean;
}

const REPLY_ACTIONS = [{ name: 'reply', label: 'Reply' }];
// Android's default ("highQuality") line breaking can measure a short line narrower than it draws
// with some system fonts (OnePlus's): the text then wraps where it may break ("/compact" after the
// slash) and the bubble, sized for one line, clips the rest. "simple" measures and draws alike.
const BREAK = 'simple';

export const ItemView = memo(function ItemView({ item, onPress, tick, status, onRetry, onReply, onQuote, highlight }: ItemViewProps) {
  const a11yReply = onReply ? { accessibilityActions: REPLY_ACTIONS, onAccessibilityAction: () => onReply(item) } : {};
  switch (item.kind) {
    case 'user': {
      const from = ORIGIN_LABEL[item.origin];
      const failed = tick === 'failed';
      const retry = failed && item.local && !item.local.final && onRetry ? () => onRetry(item.local!.key) : undefined;
      const caption = failed ? (item.local?.error ?? 'Not sent') : status ? STATUS_TEXT[status] : undefined;
      return (
        <View style={styles.userWrap}>
          <Pressable
            style={[styles.bubble, styles.user, failed && styles.userFailed, highlight && styles.highlight]}
            onPress={retry}
            disabled={!retry}
            accessibilityHint={retry ? 'Send again' : undefined}
            {...a11yReply}
          >
            {from || item.voice ? <Text style={styles.meta}>{[from, item.voice ? '🎙 voice' : ''].filter(Boolean).join(' · ')}</Text> : null}
            {item.replyTo ? <QuoteView quote={item.replyTo} onPress={onQuote ? () => onQuote(item.id, item.replyTo!.text) : undefined} /> : null}
            {item.attachments.length ? <SentAttachments list={item.attachments} /> : null}
            {item.text ? (
              <Text style={styles.text} selectable textBreakStrategy={BREAK}>
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
        <View style={[styles.bubble, styles.assistant, highlight && styles.highlight]} {...a11yReply}>
          {item.lane === 'side' ? <Text style={styles.meta}>⚡ Parallel answer (the main conversation was busy)</Text> : null}
          <Text style={styles.text} selectable textBreakStrategy={BREAK}>
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
          <Text style={styles.text} selectable textBreakStrategy={BREAK}>
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

/** Who wrote a quoted message, as its label says. */
export function quoteLabel(from: Quote['from']): string {
  return from === 'edith' ? 'EDITH' : from === 'arpit' ? 'You' : 'Replying to';
}

/** The quote on a reply: who and what, two lines at most; tapping it shows the original. */
function QuoteView({ quote, onPress }: { quote: Quote; onPress?: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={styles.quote}
      accessibilityRole="button"
      accessibilityLabel={`Reply to ${quote.from === 'edith' ? 'EDITH' : quote.from === 'arpit' ? 'your message' : 'a message'}: ${quote.text}`}
      accessibilityHint="Shows the original message"
    >
      <Text style={styles.quoteFrom}>{quoteLabel(quote.from)}</Text>
      <Text style={styles.quoteText} numberOfLines={2}>
        {quote.text}
      </Text>
    </Pressable>
  );
}

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
  attachmentChip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, maxWidth: 220, backgroundColor: colors.cardRaised, borderRadius: radius.s, paddingHorizontal: space.s, paddingVertical: space.xs },
  attachmentName: { color: colors.text, fontSize: type.size.small, flexShrink: 1 },
  // Every bubble has a 1 dp border, clear unless marked: a failed send or the jump-to mark changes
  // only its colour, so the bubble never shifts by a pixel.
  bubble: { borderRadius: radius.l, paddingHorizontal: space.m, paddingVertical: space.s + 2, marginVertical: space.xs, maxWidth: '88%', borderWidth: 1, borderColor: 'transparent' },
  userWrap: { alignSelf: 'flex-end', alignItems: 'flex-end', maxWidth: '88%', marginVertical: space.xs },
  user: { backgroundColor: colors.userBubble, borderBottomRightRadius: radius.s, maxWidth: '100%', marginVertical: 0 },
  userFailed: { borderColor: colors.danger },
  highlight: { borderColor: colors.accent },
  quote: { backgroundColor: colors.code, borderLeftWidth: 3, borderLeftColor: colors.accent, borderRadius: radius.s, paddingHorizontal: space.s, paddingVertical: space.xs, marginBottom: space.xs },
  quoteFrom: { color: colors.accent, fontSize: type.size.caption, fontWeight: '700' },
  quoteText: { color: colors.textDim, fontSize: type.size.small },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 2 },
  time: { color: colors.textDim, fontSize: type.size.caption },
  reaction: { marginTop: -10, marginRight: space.s, backgroundColor: colors.cardRaised, borderRadius: radius.pill, paddingHorizontal: 5, paddingVertical: 1, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  reactionText: { fontSize: 14 },
  caption: { color: colors.textDim, fontSize: type.size.caption, marginTop: 2, marginRight: space.xs },
  captionError: { color: colors.danger },
  assistant: { backgroundColor: colors.assistantBubble, alignSelf: 'flex-start', borderBottomLeftRadius: radius.s, borderColor: colors.hairline },
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
