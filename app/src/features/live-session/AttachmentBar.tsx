// The composer's attachments: a strip of thumbnails (images) and chips (audio), each with its upload
// progress, a remove button, and tap-to-retry when its upload failed. They're added from the
// composer's menu (ComposerMenu).

import { memo } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatBytes } from '../../common/format';
import { useStore } from '../../core/store';
import { Icon } from '../../ui/Icon';
import { colors, radius, space, useTheme } from '../../core/theme';
import type { AttachmentsModel, Draft, DraftsState } from './attachments';

const selectDrafts = (s: DraftsState) => s.drafts;
const selectError = (s: DraftsState) => s.error;
const selectPicking = (s: DraftsState) => s.picking;

export const AttachmentBar = memo(function AttachmentBar({ attach }: { attach: AttachmentsModel }) {
  const drafts = useStore(attach.store, selectDrafts);
  const error = useStore(attach.store, selectError);
  const picking = useStore(attach.store, selectPicking);
  const { accent } = useTheme();
  if (!drafts.length && !error && !picking) return null;
  return (
    <View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {drafts.length || picking ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip} keyboardShouldPersistTaps="handled">
          {drafts.map((d) => (
            <DraftChip key={d.key} draft={d} attach={attach} />
          ))}
          {picking ? <ActivityIndicator style={styles.picking} color={accent} /> : null}
        </ScrollView>
      ) : null}
    </View>
  );
});

const DraftChip = memo(function DraftChip({ draft: d, attach }: { draft: Draft; attach: AttachmentsModel }) {
  const failed = d.status === 'failed';
  const { accent } = useTheme();
  const pct = d.total ? Math.min(100, Math.floor((100 * d.sent) / d.total)) : 0;
  const label = failed ? 'Upload failed, tap to retry' : d.status === 'uploading' ? `Uploading ${pct}%` : 'Ready';
  return (
    <Pressable
      style={[styles.chip, d.kind === 'image' && styles.imageChip, failed && styles.failed]}
      onPress={failed ? () => void attach.retry(d.key) : undefined}
      disabled={!failed}
      accessibilityLabel={`${d.name}, ${label}`}
      accessibilityHint={failed ? (d.error ?? undefined) : undefined}
    >
      {d.kind === 'image' ? (
        <Image source={{ uri: d.uri }} style={styles.thumb} />
      ) : (
        <View style={styles.audio}>
          <Icon name="music-note-outline" size={18} color={accent} />
          <View style={styles.audioText}>
            <Text style={styles.name} numberOfLines={1}>
              {d.name}
            </Text>
            <Text style={styles.meta}>{d.size ? formatBytes(d.size) : ''}</Text>
          </View>
        </View>
      )}
      {d.status === 'uploading' ? (
        <View style={styles.overlay}>
          <Text style={styles.pct}>{pct}%</Text>
        </View>
      ) : null}
      {failed ? (
        <View style={styles.overlay}>
          <Icon name="refresh" size={18} color={colors.danger} />
        </View>
      ) : null}
      <Pressable style={styles.remove} onPress={() => attach.remove(d.key)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${d.name}`}>
        <Icon name="close" size={12} color={colors.text} />
      </Pressable>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  strip: { gap: space.s, paddingHorizontal: space.s, paddingTop: space.s, alignItems: 'center' },
  picking: { marginHorizontal: space.s },
  error: { color: colors.danger, fontSize: 13, paddingHorizontal: space.m, paddingTop: space.s },
  chip: { borderRadius: radius.m, backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, overflow: 'hidden' },
  imageChip: { width: 64, height: 64 },
  failed: { borderColor: colors.danger },
  thumb: { width: 64, height: 64 },
  audio: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m, height: 64, maxWidth: 220 },
  audioText: { flexShrink: 1 },
  name: { color: colors.text, fontSize: 13 },
  meta: { color: colors.textDim, fontSize: 11 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.overlay },
  pct: { color: colors.text, fontSize: 12, fontWeight: '600' },
  remove: { position: 'absolute', top: 3, right: 3, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.overlayStrong },
});
