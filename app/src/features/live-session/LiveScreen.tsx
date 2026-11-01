import { memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ActivityIndicator, Alert, FlatList, StyleSheet, Text, TextInput, View, type LayoutChangeEvent } from 'react-native';

import type { Command } from '../../core/api';
import { createStore, useStore, type Store } from '../../core/store';
import { colors, radius, space, type, useChrome, useTheme } from '../../core/theme';
import { Empty } from '../../ui/Empty';
import { Glass, useBackdrop } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { SettleIn, Squish, useReduceMotion } from '../../ui/motion';
import { SwipeToReply } from '../../ui/SwipeToReply';
import { toast } from '../../ui/toast';
import { ItemView, quoteLabel } from './ItemView';
import { needsArgs, sendStatus, summarize, tickOf, type Item, type LiveModel, type LiveState, type SendStatus, type Tick } from './model';
import { findQuoted, quoteOf, type Quote } from './reply';
import { backgroundStopPrompt } from './status';
import { WorkingRow } from './WorkingRow';
import { AttachmentBar } from './AttachmentBar';
import { CLOSE_LABEL, ComposerMenu, MENU_LABEL } from './ComposerMenu';
import type { AttachmentsModel, DraftsState } from './attachments';
import { VoiceBar } from './VoiceBar';
import type { VoiceModel, VoiceState } from './voice';

const selectItems = (s: LiveState) => s.items;
const selectTurns = (s: LiveState) => s.turns;
const keyOf = (item: Item) => String(item.id);

export interface LiveScreenProps {
  model: LiveModel;
  voice: VoiceModel;
  attach: AttachmentsModel;
  /** Whether the composer's menu is open: its button and panel share it, and the feature closes it when another screen comes up. */
  menu: Store<boolean>;
  /** The message being replied to (swipe to reply): its quote bar sits above the composer until sent or cancelled. */
  reply: Store<Quote | null>;
}

const FLASH_MS = 1600; // how long the message a quote jumped to stays marked

export function LiveScreen({ model, voice, attach, menu, reply }: LiveScreenProps) {
  const items = useStore(model.store, selectItems);
  const onPress = useCallback(
    (id: number, action: string) =>
      model.press(id, action).then(toast, (e: unknown) => toast(`Couldn't press it: ${e instanceof Error ? e.message : String(e)}`)),
    [model],
  );
  const turns = useStore(model.store, selectTurns); // changes only when a turn changes phase (not per progress event)
  const onRetry = useCallback((key: string) => void model.retry(key), [model]);
  const onReply = useCallback((item: Item) => reply.set(quoteOf(item)), [reply]);

  // Tapping a reply's quote scrolls to the message it quotes and marks it for a moment. The mark is
  // a store each row reads for its own id, so it re-renders only the two rows it moves between.
  const list = useRef<FlatList<Item>>(null);
  const reduce = useReduceMotion();
  const flash = useMemo(() => createStore<number | null>(null), []);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRetry = useRef<{ timer: ReturnType<typeof setTimeout> | null; tries: number }>({ timer: null, tries: 0 });
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
      if (scrollRetry.current.timer) clearTimeout(scrollRetry.current.timer);
    },
    [],
  );
  const onQuote = useCallback(
    (replyId: number, quote: string) => {
      const items = model.store.get().items;
      const index = findQuoted(items, quote, replyId);
      if (index < 0) {
        toast("The original message is further back than what's loaded.");
        return;
      }
      flash.set(items[index]!.id);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => flash.set(null), FLASH_MS);
      if (scrollRetry.current.timer) clearTimeout(scrollRetry.current.timer);
      scrollRetry.current = { timer: null, tries: 0 };
      list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: !reduce });
    },
    [model, reduce, flash],
  );
  // A row far up hasn't been measured yet: jump near it by the average height, then aim again
  // (a few times at most: each jump measures more rows).
  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      const retry = scrollRetry.current;
      if (retry.tries >= MAX_SCROLL_TRIES) return;
      retry.tries++;
      list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
      if (retry.timer) clearTimeout(retry.timer);
      retry.timer = setTimeout(() => {
        retry.timer = null;
        list.current?.scrollToIndex({ index: info.index, viewPosition: 0.5, animated: !reduce });
      }, 50);
    },
    [reduce],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Item; index: number }) => (
      // The newest message, if it just arrived, settles in on a spring; history and rows scrolled
      // back into view don't move.
      <SettleIn animate={index === 0 && Date.now() / 1000 - item.ts < FRESH_S}>
        <Row
          item={item}
          tick={item.kind === 'user' ? tickOf(item, turns) : null}
          status={item.kind === 'user' ? sendStatus(item, turns) : null}
          flash={flash}
          onPress={onPress}
          onRetry={onRetry}
          onReply={onReply}
          onQuote={onQuote}
        />
      </SettleIn>
    ),
    [onPress, onRetry, onReply, onQuote, flash, turns],
  );
  const loadOlder = useCallback(() => void model.loadOlder(), [model]);
  const chromeInsets = useChrome();
  // The transcript is the backdrop of the composer and the status pill: it scrolls under them (and
  // under the header), which bend and blur it. Inverted, so its visual top is paddingBottom.
  const backdrop = useBackdrop();
  const [composerHeight, setComposerHeight] = useState(COMPOSER_HEIGHT);
  const onComposerLayout = useCallback((e: LayoutChangeEvent) => setComposerHeight(Math.round(e.nativeEvent.layout.height)), []);
  const below = chromeInsets.bottom + composerHeight;
  const listInsets = useMemo(() => ({ paddingBottom: chromeInsets.top + space.s, paddingTop: below + space.s }), [chromeInsets.top, below]);
  // The composer's menu (`menu`): its button (in the composer) and its panel (over the whole
  // screen, so a tap anywhere outside closes it) share it; toggling it re-renders only those two
  // and the transcript's wrapper (hidden from TalkBack while the menu is open).
  const draft = useRef<DraftHandle>(null);
  const loadCommands = useCallback(() => model.commands(), [model]);
  const onCommand = useCallback(
    (c: Command) => {
      if (needsArgs(c)) draft.current?.insert(`/${c.name} `); // finish its arguments in the box
      else void model.send(`/${c.name}`); // none, or only optional ones ("[instructions]"): run it
    },
    [model],
  );
  return (
    <View style={styles.screen}>
      <Transcript menu={menu} viewRef={backdrop.ref}>
        {items.length ? (
          <FlatList
            ref={list}
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
            onScrollToIndexFailed={onScrollToIndexFailed}
            onEndReached={loadOlder} // the "end" of an inverted list is the top: older history
            onEndReachedThreshold={0.5}
            ListFooterComponent={<OlderSpinner model={model} />}
            ListHeaderComponent={<WorkingRow model={model} />} // an inverted list's header sits at the bottom
          />
        ) : (
          // Outside the list: an inverted list would draw its empty component upside down.
          <View style={[styles.screen, { paddingTop: chromeInsets.top + space.s, paddingBottom: below }]}>
            <Empty icon="message-processing-outline" title="Nothing yet" detail="EDITH's live session shows up here as it happens, from the app, Telegram or the terminal." />
          </View>
        )}
      </Transcript>
      <ComposerMenu open={menu} bottom={below + space.xs} backdrop={backdrop.tag} attach={attach} voice={voice} loadCommands={loadCommands} onCommand={onCommand} />
      <View style={[styles.composerSlot, { bottom: chromeInsets.bottom }]} onLayout={onComposerLayout} pointerEvents="box-none">
        <Composer model={model} voice={voice} attach={attach} backdrop={backdrop.tag} menu={menu} reply={reply} handle={draft} />
      </View>
    </View>
  );
}

const COMPOSER_HEIGHT = 60; // until the composer has measured itself
const FRESH_S = 4; // a message this new (by its timestamp) arrived just now

const MAX_SCROLL_TRIES = 3; // jumping to a quoted message that isn't measured yet

interface RowProps {
  item: Item;
  tick: Tick | null;
  status: SendStatus | null;
  flash: Store<number | null>;
  onPress: (id: number, action: string) => Promise<unknown>;
  onRetry: (key: string) => void;
  onReply: (item: Item) => void;
  onQuote: (itemId: number, quote: string) => void;
}

/**
 * One transcript row: Arpit's and EDITH's messages can be swiped to reply. Its props are plain
 * values and stable callbacks (the swipe's own is made here, per item), so the memo holds; the
 * quote-jump mark is read from `flash` for this row's id only.
 */
const Row = memo(function Row({ item, tick, status, flash, onPress, onRetry, onReply, onQuote }: RowProps) {
  const id = item.id;
  const marked = useCallback((f: number | null) => f === id, [id]);
  const highlight = useStore(flash, marked);
  const swiped = useCallback(() => onReply(item), [onReply, item]);
  if (item.kind === 'user') {
    return (
      <SwipeToReply onReply={swiped}>
        <ItemView item={item} onPress={onPress} tick={tick} status={status} onRetry={onRetry} onReply={onReply} onQuote={onQuote} highlight={highlight} />
      </SwipeToReply>
    );
  }
  if (item.kind === 'assistant') {
    return (
      <SwipeToReply onReply={swiped}>
        <ItemView item={item} onPress={onPress} onReply={onReply} highlight={highlight} />
      </SwipeToReply>
    );
  }
  return <ItemView item={item} onPress={onPress} />;
});

const selectLoadingOlder = (s: LiveState) => s.loadingOlder;

/**
 * The transcript's view (the glass's backdrop). While the composer's menu is open TalkBack skips it,
 * so swiping stays in the menu. Only this re-renders when the menu toggles: `children` is the same
 * element, so the list itself doesn't.
 */
function Transcript({ menu, viewRef, children }: { menu: Store<boolean>; viewRef: (v: View | null) => void; children: ReactNode }) {
  const open = useStore(menu, selectOpen);
  return (
    <View ref={viewRef} collapsable={false} style={styles.screen} importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}>
      {children}
    </View>
  );
}

const OlderSpinner = memo(function OlderSpinner({ model }: { model: LiveModel }) {
  const loading = useStore(model.store, selectLoadingOlder);
  return loading ? <ActivityIndicator style={styles.older} color={colors.textDim} /> : null;
});

const selectBusy = (s: LiveState) => summarize(s).busy;
const selectBackground = (s: LiveState) => s.background;

const selectVoicePhase = (s: VoiceState) => s.phase;
const selectVoiceError = (s: VoiceState) => s.error;
const selectVoiceAvailable = (s: VoiceState) => s.available;

const selectDrafts = (s: DraftsState) => s.drafts;
const selectAttachError = (s: DraftsState) => s.error;
const selectPicking = (s: DraftsState) => s.picking;
const selectOpen = (s: boolean) => s; // the composer menu's store
const selectQuote = (s: Quote | null) => s; // the reply's store

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
  reply: Store<Quote | null>;
  handle: RefObject<DraftHandle | null>;
}

/**
 * Three glass pieces with gaps (Arpit's reference): the round menu button, the message pill (with
 * the mic, or Stop while EDITH works, inside on the right) and the round send button. Attachments
 * and errors sit on their own glass above. It never re-renders for the keyboard: its props don't change.
 */
const Composer = memo(function Composer({ model, voice, attach, backdrop, menu, reply, handle }: ComposerProps) {
  const busy = useStore(model.store, selectBusy);
  const background = useStore(model.store, selectBackground);
  const voicePhase = useStore(voice.store, selectVoicePhase);
  const voiceError = useStore(voice.store, selectVoiceError);
  const canTalk = useStore(voice.store, selectVoiceAvailable);
  const drafts = useStore(attach.store, selectDrafts);
  const attachError = useStore(attach.store, selectAttachError);
  const picking = useStore(attach.store, selectPicking);
  const menuOpen = useStore(menu, selectOpen);
  const quote = useStore(reply, selectQuote);
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
  // A message just swiped: type the reply straight away.
  useEffect(() => {
    if (quote) input.current?.focus();
  }, [quote]);
  const cancelReply = useCallback(() => reply.set(null), [reply]);

  const uploading = drafts.some((d) => d.status === 'uploading');
  const attachmentsReady = drafts.length > 0 && drafts.every((d) => d.status === 'ready');
  // Text, ready attachments or both; never while an upload runs or one failed (retry or remove it first).
  const canSend = (!!text.trim() || attachmentsReady) && (drafts.length === 0 || attachmentsReady);

  const closeMenu = useCallback(() => menu.set(false), [menu]);
  const toggleMenu = useCallback(() => menu.set((o) => !o), [menu]);
  const edit = (t: string) => {
    setText(t);
    if (!t.trim()) setFromVoice(false);
  };
  const send = useCallback(() => {
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
    const replyTo = reply.get();
    reply.set(null);
    void model.send(t, { voice: fromVoice, attachments, replyTo });
  }, [closeMenu, canSend, attach, text, fromVoice, model, reply]);
  const stop = () => {
    setStopping(true);
    model.stop().then(toast, (e: unknown) => toast(`Couldn't stop: ${e instanceof Error ? e.message : String(e)}`)).finally(() => setStopping(false));
  };
  // Only background work runs: say what Stop would (not) cancel, and offer to ask EDITH instead.
  const stopBackground = () => {
    const p = backgroundStopPrompt(background, Date.now() / 1000 + model.store.get().clockOffset); // the server's clock
    Alert.alert(p.title, p.message, [
      { text: 'Keep running', style: 'cancel' },
      { text: 'Ask EDITH to cancel', style: 'destructive', onPress: () => void model.send(p.request) },
    ]);
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
  const extras = (!!voiceError && !talking) || drafts.length > 0 || !!attachError || picking || !!quote;
  return (
    <View style={styles.composer}>
      {extras ? (
        <Glass level="control" backdrop={backdrop} radius={radius.l} rim style={styles.extras}>
          {quote ? <ReplyBar quote={quote} onCancel={cancelReply} /> : null}
          {voiceError && !talking ? <Text style={styles.voiceError}>{voiceError}</Text> : null}
          <AttachmentBar attach={attach} />
        </Glass>
      ) : null}
      <View style={styles.row}>
        <RoundButton icon="dots" onPress={toggleMenu} disabled={talking} label={menuOpen ? CLOSE_LABEL : MENU_LABEL} expanded={menuOpen} />
        <Glass level="control" backdrop={backdrop} radius={ROUND / 2} rim style={styles.pill}>
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
                placeholder="Message"
                placeholderTextColor={colors.textFaint}
                multiline
                maxLength={8000}
                accessibilityLabel="Message"
              />
              {busy ? (
                <InlineButton icon="stop-circle-outline" color={colors.danger} onPress={stop} busy={stopping} label="Stop" />
              ) : background.length ? (
                // Not a turn: calm, and it explains rather than stops.
                <InlineButton icon="timer-sand" color={colors.textSecondary} onPress={stopBackground} label="Background work running" />
              ) : null}
              {canTalk ? <InlineButton icon="microphone-outline" color={colors.text} onPress={talk} busy={voicePhase === 'starting'} label="Talk to EDITH" /> : null}
            </View>
          )}
        </Glass>
        <RoundButton icon="send" onPress={send} disabled={talking || !canSend} busy={uploading} label={uploading ? 'Send (waiting for the upload)' : 'Send'} />
      </View>
    </View>
  );
});

/**
 * A round glass button (the menu and send): the whole piece squishes when pressed. Flat glass with
 * the rim (no live backdrop): two fewer real-glass views moving while the keyboard animates; the
 * control level's flat colour matches the pill's frost. Its icon is drawn here, so its props are
 * plain values and the memo holds.
 */
const RoundButton = memo(function RoundButton({
  icon,
  onPress,
  disabled,
  busy,
  label,
  expanded,
}: {
  icon: 'dots' | 'send';
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  label: string;
  expanded?: boolean;
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
      <Glass level="control" backdrop={null} radius={ROUND / 2} rim style={styles.roundGlass}>
        {busy ? (
          <ActivityIndicator color={colors.textDim} />
        ) : icon === 'dots' ? (
          <DotGrid />
        ) : (
          <Icon name="send-outline" size={SEND_ICON} color={disabled ? colors.textFaint : colors.text} />
        )}
      </Glass>
    </Squish>
  );
});

/** The quote bar above the message box: what the next message replies to, with ✕ to drop it. */
function ReplyBar({ quote, onCancel }: { quote: Quote; onCancel: () => void }) {
  const who = quote.from === 'edith' ? 'EDITH' : quote.from === 'arpit' ? 'your message' : 'a message';
  const { accent } = useTheme();
  return (
    <View style={styles.reply}>
      <View style={[styles.replyText, { borderLeftColor: accent }]} accessible accessibilityLabel={`Replying to ${who}: ${quote.text}`}>
        <Text style={[styles.replyFrom, { color: accent }]}>{quote.from ? `Replying to ${quoteLabel(quote.from)}` : quoteLabel(null)}</Text>
        <Text style={styles.replyQuote} numberOfLines={2}>
          {quote.text}
        </Text>
      </View>
      <Squish onPress={onCancel} style={styles.replyClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel the reply">
        <Icon name="close" size={18} color={colors.textDim} />
      </Squish>
    </View>
  );
}

/** An icon button inside the message pill (the mic, Stop). */
function InlineButton({ icon, color, onPress, busy, label }: { icon: string; color: string; onPress: () => void; busy?: boolean; label: string }) {
  return (
    <Squish onPress={onPress} disabled={busy} style={styles.inline} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ busy: !!busy }}>
      {busy ? <ActivityIndicator color={color} /> : <Icon name={icon} size={PILL_ICON} color={color} />}
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

// Proportions measured from Arpit's reference (an 82 px button): the pill is exactly as tall as the
// round buttons, the gaps are 0.18 of that height, the 2×2 dots are 0.15 of it with 0.12 between,
// the text is about 0.33 of it and the icons about half.
const ROUND = 52; // the round buttons, and the pill's height on one line
const GAP = 10;
const DOT = 8;
const DOT_GAP = 6;
const PILL_ICON = 28;
const SEND_ICON = 26;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingHorizontal: space.m, paddingTop: space.s, flexGrow: 1 },
  older: { padding: space.m },
  composerSlot: { position: 'absolute', left: 0, right: 0 },
  composer: { marginHorizontal: space.m, marginBottom: space.s, gap: GAP },
  extras: { paddingBottom: space.s },
  reply: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingLeft: space.m, paddingRight: space.xs, paddingTop: space.s },
  replyText: { flex: 1, borderLeftWidth: 3, paddingLeft: space.s },
  replyFrom: { fontSize: type.size.caption, fontWeight: '700' },
  replyQuote: { color: colors.textDim, fontSize: type.size.small },
  replyClose: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: GAP },
  round: { width: ROUND, height: ROUND },
  roundGlass: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pill: { flex: 1, minHeight: ROUND, justifyContent: 'center' },
  pillRow: { flexDirection: 'row', alignItems: 'flex-end', paddingRight: space.s },
  inline: { width: 44, height: ROUND, alignItems: 'center', justifyContent: 'center' },
  voiceError: { color: colors.danger, fontSize: type.size.small, paddingHorizontal: space.m, paddingTop: space.s },
  input: { flex: 1, color: colors.text, paddingLeft: space.l, paddingRight: space.s, paddingVertical: 14, fontSize: type.size.title, fontWeight: '500', maxHeight: 140, minHeight: ROUND },
  dots: { width: 2 * DOT + DOT_GAP, flexDirection: 'row', flexWrap: 'wrap', gap: DOT_GAP },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2, backgroundColor: colors.text },
});
