import { memo, useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TextInput, View } from 'react-native';

import { shallowEqual, useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { colors, radius, space } from '../../ui/theme';
import { toast } from '../../ui/toast';
import { ItemView } from './ItemView';
import { summarize, type Item, type LiveModel, type LiveState } from './model';

const selectItems = (s: LiveState) => s.items;
const selectTitle = (s: LiveState) => s.session?.title ?? null;
const keyOf = (item: Item) => String(item.id);

export function LiveScreen({ model }: { model: LiveModel }) {
  const items = useStore(model.store, selectItems);
  const onPress = useCallback(
    (id: number, action: string) =>
      model.press(id, action).then(toast, (e: unknown) => toast(`Couldn't press it: ${e instanceof Error ? e.message : String(e)}`)),
    [model],
  );
  const renderItem = useCallback(({ item }: { item: Item }) => <ItemView item={item} onPress={onPress} />, [onPress]);
  const loadOlder = useCallback(() => void model.loadOlder(), [model]);
  return (
    <View style={styles.screen}>
      <TurnBar model={model} />
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
        />
      ) : (
        // Outside the list: an inverted list would draw its empty component upside down.
        <Empty icon="message-processing-outline" title="Nothing yet" detail="EDITH's live session shows up here as it happens, from the app, Telegram or the terminal." />
      )}
      <Composer model={model} />
    </View>
  );
}

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
    <View style={styles.bar}>
      {t.busy ? <ActivityIndicator size="small" color={colors.warn} /> : <View style={styles.idleDot} />}
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
    </View>
  );
});

const selectBusy = (s: LiveState) => summarize(s).busy;

const Composer = memo(function Composer({ model }: { model: LiveModel }) {
  const busy = useStore(model.store, selectBusy);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);

  const send = () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    model.send(t).then(
      () => setText(''),
      (e: unknown) => toast(`Not sent: ${e instanceof Error ? e.message : String(e)}`),
    ).finally(() => setSending(false));
  };
  const stop = () => {
    setStopping(true);
    model.stop().then(toast, (e: unknown) => toast(`Couldn't stop: ${e instanceof Error ? e.message : String(e)}`)).finally(() => setStopping(false));
  };

  return (
    <View style={styles.composer}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={setText}
        placeholder="Message EDITH"
        placeholderTextColor={colors.textDim}
        multiline
        maxLength={8000}
        accessibilityLabel="Message"
      />
      {busy ? <Button icon="stop" variant="danger" onPress={stop} busy={stopping} accessibilityLabel="Stop" /> : null}
      <Button icon="send" variant="primary" onPress={send} busy={sending} disabled={!text.trim()} accessibilityLabel="Send" />
    </View>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  list: { paddingHorizontal: space.m, paddingVertical: space.s, flexGrow: 1 },
  older: { padding: space.m },
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m, paddingVertical: space.s, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  idleDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.ok, marginHorizontal: 5 },
  barText: { color: colors.text, fontSize: 13, flex: 1 },
  barTitle: { color: colors.textDim, fontSize: 12, maxWidth: '40%' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: space.s, padding: space.s, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  input: { flex: 1, color: colors.text, backgroundColor: colors.surface, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: 15, maxHeight: 140, minHeight: 44 },
});
