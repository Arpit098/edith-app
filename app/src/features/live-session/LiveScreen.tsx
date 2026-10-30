import { memo, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { shallowEqual, useStore } from '../../core/store';
import { colors, radius, space, type, useChrome } from '../../core/theme';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { Glass } from '../../ui/Glass';
import { toast } from '../../ui/toast';
import { ItemView } from './ItemView';
import { sendStatus, summarize, tickOf, type Item, type LiveModel, type LiveState } from './model';
import { WorkingRow } from './WorkingRow';
import { AttachmentBar, AttachMenu } from './AttachmentBar';
import type { AttachmentsModel, DraftsState } from './attachments';
import { VoiceBar } from './VoiceBar';
import type { VoiceModel, VoiceState } from './voice';

const selectItems = (s: LiveState) => s.items;
const selectTurns = (s: LiveState) => s.turns;
const selectTitle = (s: LiveState) => s.session?.title ?? null;
const keyOf = (item: Item) => String(item.id);

export function LiveScreen({ model, voice, attach }: { model: LiveModel; voice: VoiceModel; attach: AttachmentsModel }) {
  const items = useStore(model.store, selectItems);
  const onPress = useCallback(
    (id: number, action: string) =>
      model.press(id, action).then(toast, (e: unknown) => toast(`Couldn't press it: ${e instanceof Error ? e.message : String(e)}`)),
    [model],
  );
  const turns = useStore(model.store, selectTurns); // changes only when a turn changes phase (not per progress event)
  const onRetry = useCallback((key: string) => void model.retry(key), [model]);
  const renderItem = useCallback(
    ({ item }: { item: Item }) =>
      item.kind === 'user' ? (
        <ItemView item={item} onPress={onPress} tick={tickOf(item, turns)} status={sendStatus(item, turns)} onRetry={onRetry} />
      ) : (
        <ItemView item={item} onPress={onPress} />
      ),
    [onPress, onRetry, turns],
  );
  const loadOlder = useCallback(() => void model.loadOlder(), [model]);
  const chromeInsets = useChrome();
  // The transcript scrolls under the header and the status pill; inverted, so its top is paddingBottom.
  const listInsets = useMemo(() => ({ paddingBottom: chromeInsets.top + TURN_BAR_SPACE }), [chromeInsets.top]);
  return (
    <View style={[styles.screen, { paddingBottom: chromeInsets.bottom }]}>
      {items.length ? (
        <FlatList
          data={items}
          inverted // items are stored newest first: the newest sits at the bottom with no scroll-to-end
          keyExtractor={keyOf}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, listInsets]}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={9}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          onEndReached={loadOlder} // the "end" of an inverted list is the top: older history
          onEndReachedThreshold={0.5}
          ListFooterComponent={<OlderSpinner model={model} />}
          ListHeaderComponent={<WorkingRow model={model} />} // an inverted list's header sits at the bottom
        />
      ) : (
        // Outside the list: an inverted list would draw its empty component upside down.
        <View style={[styles.screen, { paddingTop: chromeInsets.top + TURN_BAR_SPACE }]}>
          <Empty icon="message-processing-outline" title="Nothing yet" detail="EDITH's live session shows up here as it happens, from the app, Telegram or the terminal." />
        </View>
      )}
      <Composer model={model} voice={voice} attach={attach} />
      <View style={[styles.barSlot, { top: chromeInsets.top + space.s }]} pointerEvents="box-none">
        <TurnBar model={model} />
      </View>
    </View>
  );
}

const TURN_BAR_SPACE = 52; // the floating status pill plus its margins

const selectLoadingOlder = (s: LiveState) => s.loadingOlder;

const OlderSpinner = memo(function OlderSpinner({ model }: { model: LiveModel }) {
  const loading = useStore(model.store, selectLoadingOlder);
  return loading ? <ActivityIndicator style={styles.older} color={colors.textDim} /> : null;
});

/** "Working · $ npm test · 42s" or "Idle", plus the conversation title. */
const TurnBar = memo(function TurnBar({ model }: { model: LiveModel }) {
  const t = useStore(model.store, summarize, shallowEqual);
  const title = useStore(model.store, selectTitle);
  return (
    <Glass level="thin" radius={radius.pill} style={styles.bar}>
      {t.busy ? <ActivityIndicator size="small" color={colors.accent} /> : <View style={styles.idleDot} />}
      <Text style={styles.barText} numberOfLines={1}>
        {t.busy ? ['Working', t.step, t.elapsed ? `${t.elapsed}s` : null].filter(Boolean).join(' · ') : 'Idle'}
        {t.running > 1 ? ` (+${t.running - 1} parallel)` : ''}
        {t.queued ? ` · ${t.queued} queued` : ''}
      </Text>
      {title ? (
        <Text style={styles.barTitle} numberOfLines={1}>
          {title}
        </Text>
      ) : null}
    </Glass>
  );
});

const selectBusy = (s: LiveState) => summarize(s).busy;

const selectVoicePhase = (s: VoiceState) => s.phase;
const selectVoiceError = (s: VoiceState) => s.error;
const selectVoiceAvailable = (s: VoiceState) => s.available;

const selectDrafts = (s: DraftsState) => s.drafts;

const Composer = memo(function Composer({ model, voice, attach }: { model: LiveModel; voice: VoiceModel; attach: AttachmentsModel }) {
  const busy = useStore(model.store, selectBusy);
  const voicePhase = useStore(voice.store, selectVoicePhase);
  const voiceError = useStore(voice.store, selectVoiceError);
  const canTalk = useStore(voice.store, selectVoiceAvailable);
  const drafts = useStore(attach.store, selectDrafts);
  const [text, setText] = useState('');
  const [fromVoice, setFromVoice] = useState(false); // the box holds words Arpit said: send them as voice
  const [stopping, setStopping] = useState(false);
  const [menu, setMenu] = useState(false);

  const uploading = drafts.some((d) => d.status === 'uploading');
  const attachmentsReady = drafts.length > 0 && drafts.every((d) => d.status === 'ready');
  // Text, ready attachments or both; never while an upload runs or one failed (retry or remove it first).
  const canSend = (!!text.trim() || attachmentsReady) && (drafts.length === 0 || attachmentsReady);

  const edit = (t: string) => {
    setText(t);
    if (!t.trim()) setFromVoice(false);
  };
  const send = () => {
    if (!canSend) return;
    // The model decides, not the button: an attachment still uploading (or failed) keeps the whole
    // message here, text and all, rather than going out without it.
    const attachments = attach.take();
    if (!attachments) {
      toast('Wait for the uploads to finish, or remove the one that failed.');
      return;
    }
    const t = text.trim();
    // The message shows at once with its ticks; a failure stays on its bubble with Retry.
    setText('');
    setFromVoice(false);
    void model.send(t, { voice: fromVoice, attachments });
  };
  const stop = () => {
    setStopping(true);
    model.stop().then(toast, (e: unknown) => toast(`Couldn't stop: ${e instanceof Error ? e.message : String(e)}`)).finally(() => setStopping(false));
  };
  const stopTalking = () =>
    void voice.stop().then((said) => {
      if (!said) return;
      setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said)); // add to what's typed, never replace it
      setFromVoice(true);
    });

  const talking = voicePhase !== 'idle' && voicePhase !== 'starting';
  const hasContent = !!text.trim() || drafts.length > 0;
  return (
    <Glass level="regular" radius={radius.l} style={styles.composer}>
      {voiceError && !talking ? <Text style={styles.voiceError}>{voiceError}</Text> : null}
      <AttachmentBar attach={attach} />
      {menu && !talking ? <AttachMenu attach={attach} onDone={() => setMenu(false)} /> : null}
      <View style={styles.row}>
        {!talking ? (
          <Button icon={menu ? 'close' : 'paperclip'} variant="ghost" onPress={() => setMenu((m) => !m)} accessibilityLabel={menu ? 'Close the attach menu' : 'Attach a photo or audio file'} />
        ) : null}
        {talking ? (
          <VoiceBar voice={voice} onStop={stopTalking} />
        ) : (
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={edit}
            placeholder="Message EDITH"
            placeholderTextColor={colors.textFaint}
            multiline
            maxLength={8000}
            accessibilityLabel="Message"
          />
        )}
        {busy && !talking ? <Button icon="stop" variant="danger" onPress={stop} busy={stopping} accessibilityLabel="Stop" /> : null}
        {canTalk && !talking && !hasContent ? (
          <Button icon="microphone" variant="secondary" onPress={() => void voice.start()} busy={voicePhase === 'starting'} accessibilityLabel="Talk to EDITH" />
        ) : null}
        {!talking && (hasContent || !canTalk) ? (
          <Button icon="send" variant="primary" onPress={send} busy={uploading} disabled={!canSend} accessibilityLabel={uploading ? 'Send (waiting for the upload)' : 'Send'} />
        ) : null}
      </View>
    </Glass>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingHorizontal: space.m, paddingTop: space.s, flexGrow: 1 },
  older: { padding: space.m },
  barSlot: { position: 'absolute', left: space.l, right: space.l },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m, paddingVertical: space.s },
  idleDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ok, marginHorizontal: 6 },
  barText: { color: colors.text, fontSize: type.size.small, flex: 1 },
  barTitle: { color: colors.textDim, fontSize: type.size.caption, maxWidth: '40%' },
  composer: { marginHorizontal: space.m, marginBottom: space.s },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.s, padding: space.s },
  voiceError: { color: colors.danger, fontSize: type.size.small, paddingHorizontal: space.m, paddingTop: space.s },
  input: { flex: 1, color: colors.text, backgroundColor: colors.input, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: type.size.body, maxHeight: 140, minHeight: 44 },
});
