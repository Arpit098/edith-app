import { memo, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';

import { useStore } from '../../core/store';
import { colors, radius, space, type, useChrome } from '../../core/theme';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { Glass, useBackdrop } from '../../ui/Glass';
import { SettleIn } from '../../ui/motion';
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
    ({ item, index }: { item: Item; index: number }) => (
      // The newest message, if it just arrived, settles in on a spring; history and rows scrolled
      // back into view don't move.
      <SettleIn animate={index === 0 && Date.now() / 1000 - item.ts < FRESH_S}>
        {item.kind === 'user' ? (
          <ItemView item={item} onPress={onPress} tick={tickOf(item, turns)} status={sendStatus(item, turns)} onRetry={onRetry} />
        ) : (
          <ItemView item={item} onPress={onPress} />
        )}
      </SettleIn>
    ),
    [onPress, onRetry, turns],
  );
  const loadOlder = useCallback(() => void model.loadOlder(), [model]);
  const chromeInsets = useChrome();
  // The transcript is the backdrop of the composer and the status pill: it scrolls under them (and
  // under the header and tab bar), which bend and blur it. Inverted, so its visual top is paddingBottom.
  const backdrop = useBackdrop();
  const [composerHeight, setComposerHeight] = useState(COMPOSER_HEIGHT);
  const onComposerLayout = useCallback((e: LayoutChangeEvent) => setComposerHeight(Math.round(e.nativeEvent.layout.height)), []);
  const below = chromeInsets.bottom + composerHeight;
  const listInsets = useMemo(() => ({ paddingBottom: chromeInsets.top + TURN_BAR_SPACE, paddingTop: below + space.s }), [chromeInsets.top, below]);
  return (
    <View style={styles.screen}>
      <View ref={backdrop.ref} collapsable={false} style={styles.screen}>
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
          <View style={[styles.screen, { paddingTop: chromeInsets.top + TURN_BAR_SPACE, paddingBottom: below }]}>
            <Empty icon="message-processing-outline" title="Nothing yet" detail="EDITH's live session shows up here as it happens, from the app, Telegram or the terminal." />
          </View>
        )}
      </View>
      <View style={[styles.composerSlot, { bottom: chromeInsets.bottom }]} onLayout={onComposerLayout} pointerEvents="box-none">
        <Composer model={model} voice={voice} attach={attach} backdrop={backdrop.tag} />
      </View>
      <View style={[styles.barSlot, { top: chromeInsets.top + space.s }]} pointerEvents="box-none">
        <StatusPanel model={model} backdrop={backdrop.tag} />
      </View>
    </View>
  );
}

const TURN_BAR_SPACE = 52; // the floating status pill plus its margins
const COMPOSER_HEIGHT = 68; // until the composer has measured itself
const FRESH_S = 4; // a message this new (by its timestamp) arrived just now

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

const Composer = memo(function Composer({ model, voice, attach, backdrop }: { model: LiveModel; voice: VoiceModel; attach: AttachmentsModel; backdrop: number | null }) {
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
    <Glass level="regular" backdrop={backdrop} radius={radius.l} style={styles.composer}>
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
  composerSlot: { position: 'absolute', left: 0, right: 0 },
  composer: { marginHorizontal: space.m, marginBottom: space.s },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.s, padding: space.s },
  voiceError: { color: colors.danger, fontSize: type.size.small, paddingHorizontal: space.m, paddingTop: space.s },
  input: { flex: 1, color: colors.text, backgroundColor: colors.input, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: type.size.body, maxHeight: 140, minHeight: 44 },
});
