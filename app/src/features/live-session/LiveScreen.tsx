import { memo, useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';

import type { Command } from '../../core/api';
import { createStore, useStore, type Store } from '../../core/store';
import { colors, radius, space, type, useChrome } from '../../core/theme';
import { Empty } from '../../ui/Empty';
import { Glass, useBackdrop } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { SettleIn, Squish } from '../../ui/motion';
import { toast } from '../../ui/toast';
import { ItemView } from './ItemView';
import { sendStatus, summarize, tickOf, type Item, type LiveModel, type LiveState } from './model';
import { StatusPanel } from './StatusPanel';
import { WorkingRow } from './WorkingRow';
import { AttachmentBar } from './AttachmentBar';
import { CLOSE_LABEL, ComposerMenu, MENU_LABEL } from './ComposerMenu';
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
  // under the header), which bend and blur it. Inverted, so its visual top is paddingBottom.
  const backdrop = useBackdrop();
  const [composerHeight, setComposerHeight] = useState(COMPOSER_HEIGHT);
  const onComposerLayout = useCallback((e: LayoutChangeEvent) => setComposerHeight(Math.round(e.nativeEvent.layout.height)), []);
  const below = chromeInsets.bottom + composerHeight;
  const listInsets = useMemo(() => ({ paddingBottom: chromeInsets.top + TURN_BAR_SPACE, paddingTop: below + space.s }), [chromeInsets.top, below]);
  // The composer's menu: its button (in the composer) and its panel (over the whole screen, so a
  // tap anywhere outside closes it) share this; toggling it re-renders only those two.
  const [menu] = useState(() => createStore(false));
  const draft = useRef<DraftHandle>(null);
  const loadCommands = useCallback(() => model.commands(), [model]);
  const onCommand = useCallback(
    (c: Command) => {
      if (c.usage) draft.current?.insert(`/${c.name} `); // needs arguments: finish it in the box
      else void model.send(`/${c.name}`);
    },
    [model],
  );
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
      <ComposerMenu open={menu} bottom={below + space.xs} backdrop={backdrop.tag} attach={attach} voice={voice} loadCommands={loadCommands} onCommand={onCommand} />
      <View style={[styles.composerSlot, { bottom: chromeInsets.bottom }]} onLayout={onComposerLayout} pointerEvents="box-none">
        <Composer model={model} voice={voice} attach={attach} backdrop={backdrop.tag} menu={menu} handle={draft} />
      </View>
      <View style={[styles.barSlot, { top: chromeInsets.top + space.s }]} pointerEvents="box-none">
        <StatusPanel model={model} backdrop={backdrop.tag} />
      </View>
    </View>
  );
}

const TURN_BAR_SPACE = 52; // the floating status pill plus its margins
const COMPOSER_HEIGHT = 56; // until the composer has measured itself
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
const selectAttachError = (s: DraftsState) => s.error;
const selectPicking = (s: DraftsState) => s.picking;
const selectOpen = (s: boolean) => s;

/** What the composer's menu can do to the message box. */
export interface DraftHandle {
  /** Start the message with a /command and focus the box, to finish its arguments. */
  insert(text: string): void;
}

interface ComposerProps {
  model: LiveModel;
  voice: VoiceModel;
  attach: AttachmentsModel;
  backdrop: number | null;
  menu: Store<boolean>;
  handle: RefObject<DraftHandle | null>;
}

/**
 * Three glass pieces with gaps (Arpit's reference): the round menu button, the message pill (with
 * the mic, or Stop while EDITH works, inside on the right) and the round send button. Attachments
 * and errors sit on their own glass above. It never re-renders for the keyboard: its props don't change.
 */
const Composer = memo(function Composer({ model, voice, attach, backdrop, menu, handle }: ComposerProps) {
  const busy = useStore(model.store, selectBusy);
  const voicePhase = useStore(voice.store, selectVoicePhase);
  const voiceError = useStore(voice.store, selectVoiceError);
  const canTalk = useStore(voice.store, selectVoiceAvailable);
  const drafts = useStore(attach.store, selectDrafts);
  const attachError = useStore(attach.store, selectAttachError);
  const picking = useStore(attach.store, selectPicking);
  const menuOpen = useStore(menu, selectOpen);
  const [text, setText] = useState('');
  const [fromVoice, setFromVoice] = useState(false); // the box holds words Arpit said: send them as voice
  const [stopping, setStopping] = useState(false);
  const input = useRef<TextInput>(null);

  useImperativeHandle(
    handle,
    () => ({
      insert(cmd: string) {
        setText((t) => cmd + t.trimStart());
        setFromVoice(false);
        input.current?.focus();
      },
    }),
    [],
  );

  const uploading = drafts.some((d) => d.status === 'uploading');
  const attachmentsReady = drafts.length > 0 && drafts.every((d) => d.status === 'ready');
  // Text, ready attachments or both; never while an upload runs or one failed (retry or remove it first).
  const canSend = (!!text.trim() || attachmentsReady) && (drafts.length === 0 || attachmentsReady);

  const closeMenu = () => menu.set(false);
  const edit = (t: string) => {
    setText(t);
    if (!t.trim()) setFromVoice(false);
  };
  const send = () => {
    closeMenu();
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
  const talk = () => {
    closeMenu();
    void voice.start();
  };
  const stopTalking = () =>
    void voice.stop().then((said) => {
      if (!said) return;
      setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said)); // add to what's typed, never replace it
      setFromVoice(true);
    });

  const talking = voicePhase !== 'idle' && voicePhase !== 'starting';
  const extras = (!!voiceError && !talking) || drafts.length > 0 || !!attachError || picking;
  return (
    <View style={styles.composer}>
      {extras ? (
        <Glass level="regular" backdrop={backdrop} radius={radius.l} rim style={styles.extras}>
          {voiceError && !talking ? <Text style={styles.voiceError}>{voiceError}</Text> : null}
          <AttachmentBar attach={attach} />
        </Glass>
      ) : null}
      <View style={styles.row}>
        <RoundButton backdrop={backdrop} onPress={() => menu.set((o) => !o)} disabled={talking} label={menuOpen ? CLOSE_LABEL : MENU_LABEL} expanded={menuOpen}>
          <DotGrid />
        </RoundButton>
        <Glass level="regular" backdrop={backdrop} radius={ROUND / 2} rim style={styles.pill}>
          {talking ? (
            <VoiceBar voice={voice} onStop={stopTalking} />
          ) : (
            <View style={styles.pillRow}>
              <TextInput
                ref={input}
                style={styles.input}
                value={text}
                onChangeText={edit}
                onFocus={closeMenu}
                placeholder="Message EDITH"
                placeholderTextColor={colors.textFaint}
                multiline
                maxLength={8000}
                accessibilityLabel="Message"
              />
              {busy ? <InlineButton icon="stop-circle-outline" color={colors.danger} onPress={stop} busy={stopping} label="Stop" /> : null}
              {canTalk ? <InlineButton icon="microphone-outline" color={colors.text} onPress={talk} busy={voicePhase === 'starting'} label="Talk to EDITH" /> : null}
            </View>
          )}
        </Glass>
        <RoundButton backdrop={backdrop} onPress={send} disabled={talking || !canSend} busy={uploading} label={uploading ? 'Send (waiting for the upload)' : 'Send'}>
          <Icon name="send-outline" size={22} color={canSend && !talking ? colors.text : colors.textFaint} />
        </RoundButton>
      </View>
    </View>
  );
});

/** A round glass button (the menu and send): the whole piece squishes when pressed. */
const RoundButton = memo(function RoundButton({
  backdrop,
  onPress,
  disabled,
  busy,
  label,
  expanded,
  children,
}: {
  backdrop: number | null;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  label: string;
  expanded?: boolean;
  children: ReactNode;
}) {
  const off = !!disabled || !!busy;
  return (
    <Squish
      onPress={onPress}
      disabled={off}
      style={styles.round}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy: !!busy, expanded }}
    >
      <Glass level="regular" backdrop={backdrop} radius={ROUND / 2} rim style={styles.roundGlass}>
        {busy ? <ActivityIndicator color={colors.textDim} /> : children}
      </Glass>
    </Squish>
  );
});

/** An icon button inside the message pill (the mic, Stop). */
function InlineButton({ icon, color, onPress, busy, label }: { icon: string; color: string; onPress: () => void; busy?: boolean; label: string }) {
  return (
    <Squish onPress={onPress} disabled={busy} style={styles.inline} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ busy: !!busy }}>
      {busy ? <ActivityIndicator color={color} /> : <Icon name={icon} size={24} color={color} />}
    </Squish>
  );
}

/** The menu button's icon: four dots in a 2×2 grid. */
function DotGrid() {
  return (
    <View style={styles.dots} accessible={false}>
      <View style={styles.dot} />
      <View style={styles.dot} />
      <View style={styles.dot} />
      <View style={styles.dot} />
    </View>
  );
}

const ROUND = 48; // the round buttons, and the pill's height on one line
const DOT = 7;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingHorizontal: space.m, paddingTop: space.s, flexGrow: 1 },
  older: { padding: space.m },
  barSlot: { position: 'absolute', left: space.l, right: space.l },
  composerSlot: { position: 'absolute', left: 0, right: 0 },
  composer: { marginHorizontal: space.m, marginBottom: space.s, gap: space.s },
  extras: { paddingBottom: space.s },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.s },
  round: { width: ROUND, height: ROUND },
  roundGlass: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pill: { flex: 1, minHeight: ROUND, justifyContent: 'center' },
  pillRow: { flexDirection: 'row', alignItems: 'flex-end', paddingRight: space.xs },
  inline: { width: 40, height: ROUND, alignItems: 'center', justifyContent: 'center' },
  voiceError: { color: colors.danger, fontSize: type.size.small, paddingHorizontal: space.m, paddingTop: space.s },
  input: { flex: 1, color: colors.text, paddingLeft: space.l, paddingRight: space.s, paddingVertical: space.m, fontSize: type.size.body, maxHeight: 140, minHeight: ROUND },
  dots: { width: 2 * DOT + 5, flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.text },
});
