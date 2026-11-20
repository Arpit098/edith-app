// Files EDITH sent, on its bubble (./received): a chip per file with the type's icon, the name and the
// size, or its download progress; an image shows its thumbnail once it is here (small ones download by
// themselves). Tap: download (a spinner and the percentage meanwhile), then show it full screen (image,
// text) or open it in the phone's viewer for its type; when no app opens it, Share and Save are
// offered. Long press: Share or Save. A file the server won't offer shows dimmed with the reason.
// FileViewer is the full-screen view.

import { createContext, memo, useContext, useEffect, useMemo } from 'react';
import { ActivityIndicator, Alert, FlatList, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatBytes } from '../../common/format';
import { useStore } from '../../core/store';
import { colors, radius, space, type, useTheme } from '../../core/theme';
import { Icon } from '../../ui/Icon';
import { toast } from '../../ui/toast';
import { attachmentIcon, kindOfName } from './fileIcon';
import { EXPIRED, isNoViewer, viewOf, type FileState, type Outcome, type ReceivedModel, type ReceivedState, type SentFile, type Viewing, viewRows } from './received';

/** The received-files model for the bubbles below the live screen (null in previews and tests without one). */
export const ReceivedContext = createContext<ReceivedModel | null>(null);

const NO_STATE: FileState | undefined = undefined;

function useFileState(model: ReceivedModel | null, id: string | null): FileState | undefined {
  const select = useMemo(() => (s: ReceivedState) => (id ? s.files[id] : NO_STATE), [id]);
  return useStore(model?.store ?? EMPTY, select);
}

const EMPTY = { get: () => ({ files: {}, viewing: null }) as ReceivedState, set: () => {}, subscribe: () => () => {} };

export const SentFileChips = memo(function SentFileChips({ files }: { files: SentFile[] }) {
  return (
    <View style={styles.list}>
      {files.map((f, i) => (
        <SentFileChip key={`${f.id ?? f.name}-${i}`} file={f} />
      ))}
    </View>
  );
});

function label(f: SentFile, st: FileState | undefined): string {
  if (st?.status === 'downloading') {
    const total = st.total || f.size || 0;
    return total ? `${Math.min(99, Math.floor((100 * st.written) / total))}%` : 'Downloading…';
  }
  if (st?.status === 'failed') return st.error === EXPIRED ? 'Expired (kept 7 days)' : 'Failed, tap to retry';
  return f.size !== null ? formatBytes(f.size) : '';
}

/** Share and Save for a file, in a small dialog (the long-press menu, or when no app opens it). */
export function offerShareSave(model: ReceivedModel, f: SentFile, message?: string): void {
  Alert.alert(f.name, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Save to folder', onPress: () => void model.save(f).then(toast) },
    ...(model.canShare ? [{ text: 'Share', onPress: () => void model.share(f).then(toast) }] : []),
  ]);
}

/** What a tap's answer shows: a toast, or the Share/Save dialog when no app opens the file. */
export function showOutcome(model: ReceivedModel, f: SentFile, o: Outcome): void {
  if (isNoViewer(o)) offerShareSave(model, f, o.noViewer);
  else toast(o);
}

const SentFileChip = memo(function SentFileChip({ file: f }: { file: SentFile }) {
  const model = useContext(ReceivedContext);
  const st = useFileState(model, f.id);
  const { accent } = useTheme();
  const image = viewOf(f) === 'image';
  useEffect(() => {
    if (image && model) model.prefetch(f); // the thumbnail (small images only)
  }, [image, model, f]);
  const off = !f.id || !model;
  const open = () => {
    if (model) void model.open(f).then((o) => showOutcome(model, f, o));
  };
  const menu = () => {
    if (model) offerShareSave(model, f);
  };
  const failed = st?.status === 'failed';
  const busy = st?.status === 'downloading';
  const a11y = off
    ? `${f.name}, not available: ${f.error ?? ''}`
    : `${f.name}${f.size !== null ? `, ${formatBytes(f.size)}` : ''}${busy ? `, downloading ${label(f, st)}` : failed ? ', download failed' : ''}`;
  if (image && st?.status === 'ready' && st.uri) {
    return (
      <Pressable onPress={open} onLongPress={menu} accessibilityRole="button" accessibilityLabel={`Photo ${f.name}`} accessibilityHint="Opens it full screen; long press to share or save">
        <Image source={{ uri: st.uri }} style={styles.thumb} />
      </Pressable>
    );
  }
  return (
    <Pressable
      style={[styles.chip, off && styles.off, failed && styles.failed]}
      onPress={off ? () => toast(f.error ?? 'Not available.') : open}
      onLongPress={off ? undefined : menu}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={off ? undefined : 'Downloads and opens it; long press to share or save it'}
      accessibilityState={{ busy }}
      testID="sent-file"
    >
      {busy ? (
        <ActivityIndicator size="small" color={accent} style={styles.spinner} testID="sent-file-spinner" />
      ) : (
        <Icon name={off ? 'file-cancel-outline' : attachmentIcon(kindOfName(f.name), f.name)} size={18} color={off ? colors.textDim : accent} />
      )}
      <View style={styles.texts}>
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
          {f.name}
        </Text>
        <Text style={[styles.meta, failed && styles.metaError]} numberOfLines={1}>
          {off ? 'Not available' : label(f, st)}
        </Text>
      </View>
      {busy ? (
        <View style={styles.track}>
          <View style={[styles.bar, { backgroundColor: accent, width: `${st.total || f.size ? Math.min(100, (100 * st.written) / (st.total || f.size || 1)) : 0}%` }]} />
        </View>
      ) : null}
    </Pressable>
  );
});

const selectViewing = (s: ReceivedState) => s.viewing;

/** An image or a text file EDITH sent, full screen; back or the arrow closes it, Save keeps a copy. */
export const FileViewer = memo(function FileViewer({ model }: { model: ReceivedModel }) {
  const viewing = useStore(model.store, selectViewing);
  return viewing ? <Viewer model={model} viewing={viewing} /> : null;
});

function Viewer({ model, viewing }: { model: ReceivedModel; viewing: Viewing }) {
  const insets = useSafeAreaInsets();
  const { bg, accent } = useTheme();
  const { rows, cut } = useMemo(() => viewRows(viewing.text ?? ''), [viewing]);
  const save = () => void model.save(viewing.file).then(toast);
  const share = () => void model.share(viewing.file).then(toast);
  const close = () => model.close();
  return (
    <Modal visible animationType="fade" onRequestClose={close} statusBarTranslucent>
      <View style={[styles.screen, { backgroundColor: bg, paddingTop: insets.top, paddingBottom: insets.bottom }]} accessibilityViewIsModal testID="file-viewer">
        <View style={styles.header}>
          <Pressable onPress={close} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close" style={styles.icon}>
            <Icon name="arrow-left" size={22} />
          </Pressable>
          <View style={styles.titles}>
            <Text style={styles.title} numberOfLines={1} ellipsizeMode="middle">
              {viewing.file.name}
            </Text>
            {viewing.file.size !== null ? <Text style={styles.meta}>{formatBytes(viewing.file.size)}</Text> : null}
          </View>
          {model.canShare ? (
            <Pressable onPress={share} hitSlop={10} accessibilityRole="button" accessibilityLabel="Share" style={styles.icon}>
              <Icon name="share-variant-outline" size={22} color={accent} />
            </Pressable>
          ) : null}
          <Pressable onPress={save} hitSlop={10} accessibilityRole="button" accessibilityLabel="Save to a folder" style={styles.icon}>
            <Icon name="content-save-outline" size={22} color={accent} />
          </Pressable>
        </View>
        {viewing.view === 'image' ? (
          <Image source={{ uri: viewing.uri }} style={styles.full} resizeMode="contain" accessibilityLabel={viewing.file.name} />
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(_, i) => String(i)}
            renderItem={({ item }) => <Text style={styles.line} selectable>{item || ' '}</Text>}
            initialNumToRender={60}
            contentContainerStyle={styles.lines}
            ListFooterComponent={
              cut ? (
                <Pressable onPress={save} style={styles.more} accessibilityRole="button" testID="viewer-cut">
                  <Text style={[styles.moreText, { color: accent }]}>Showing the first 200 KB. Save to see all.</Text>
                </Pressable>
              ) : null
            }
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.xs, marginTop: space.xs },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.s, maxWidth: 260, minWidth: 160, backgroundColor: colors.cardRaised, borderRadius: radius.m, paddingHorizontal: space.s, paddingVertical: space.s, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline, overflow: 'hidden' },
  off: { opacity: 0.6 },
  failed: { borderColor: colors.danger },
  texts: { flexShrink: 1 },
  spinner: { width: 18, height: 18 },
  name: { color: colors.text, fontSize: type.size.small },
  meta: { color: colors.textDim, fontSize: type.size.caption },
  metaError: { color: colors.danger },
  track: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: colors.card },
  bar: { height: 3 },
  thumb: { width: 160, height: 160, borderRadius: radius.m },
  screen: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.m, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  icon: { padding: space.xs },
  titles: { flex: 1 },
  title: { color: colors.text, fontSize: type.size.body, fontWeight: '700' },
  full: { flex: 1 },
  lines: { padding: space.m },
  more: { marginTop: space.m, padding: space.s, borderRadius: radius.s, backgroundColor: colors.card },
  moreText: { fontSize: type.size.small, fontWeight: '600' },
  line: { color: colors.text, fontFamily: type.mono, fontSize: 12, lineHeight: 18 },
});
