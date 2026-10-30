import { memo, useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { colors, radius, space } from '../../ui/theme';
import { toast } from '../../ui/toast';
import { ItemView } from './ItemView';
import { sendStatus, summarize, tickOf, type Item, type LiveModel, type LiveState } from './model';
import { StatusPanel } from './StatusPanel';
import { WorkingRow } from './WorkingRow';
import { AttachmentBar, AttachMenu } from './AttachmentBar';
import type { AttachmentsModel, DraftsState } from './attachments';
import { VoiceBar } from './VoiceBar';
import type { VoiceModel, VoiceState } from './voice';

const selectItems = (s: LiveState) => s.items;
const selectTurns = (s: LiveState) => s.turns;
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
  return (
    <View style={styles.screen}>
      <StatusPanel model={model} />
      {items.length ? (
        <FlatList
          data={items}
          inverted // items are stored newest first: the newest sits at the bottom with no scroll-to-end
          keyExtractor={keyOf}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
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
        <Empty icon="message-processing-outline" title="Nothing yet" detail="EDITH's live session shows up here as it happens, from the app, Telegram or the terminal." />
      )}
      <Composer model={model} voice={voice} attach={attach} />
    </View>
  );
}

const selectLoadingOlder = (s: LiveState) => s.loadingOlder;

const OlderSpinner = memo(function OlderSpinner({ model }: { model: LiveModel }) {
  const loading = useStore(model.store, selectLoadingOlder);
  return loading ? <ActivityIndicator style={styles.older} color={colors.textDim} /> : null;
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
    <View>
      {voiceError && !talking ? <Text style={styles.voiceError}>{voiceError}</Text> : null}
      <AttachmentBar attach={attach} />
      {menu && !talking ? <AttachMenu attach={attach} onDone={() => setMenu(false)} /> : null}
      <View style={styles.composer}>
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
            placeholderTextColor={colors.textDim}
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
    </View>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingHorizontal: space.m, paddingVertical: space.s, flexGrow: 1 },
  older: { padding: space.m },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.s, padding: space.s, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  voiceError: { color: colors.danger, fontSize: 13, paddingHorizontal: space.m, paddingTop: space.s },
  input: { flex: 1, color: colors.text, backgroundColor: colors.surface, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: 15, maxHeight: 140, minHeight: 44 },
});
