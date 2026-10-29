import { memo, useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Session } from '../../core/api';
import { useStore } from '../../core/store';
import { timeAgo } from '../../common/format';
import { Button } from '../../ui/Button';
import { Empty } from '../../ui/Empty';
import { Icon } from '../../ui/Icon';
import { colors, radius, space } from '../../ui/theme';
import { toast } from '../../ui/toast';
import type { SessionsModel, SessionsState } from './model';

const selectList = (s: SessionsState) => s.list;
const selectLoading = (s: SessionsState) => s.loading;
const selectError = (s: SessionsState) => s.error;
const selectSwitchingId = (s: SessionsState) => s.switching?.id ?? null;
const keyOf = (s: Session) => s.session_id;

export function SessionsScreen({ model }: { model: SessionsModel }) {
  const list = useStore(model.store, selectList);
  const loading = useStore(model.store, selectLoading);
  const error = useStore(model.store, selectError);
  const switchingId = useStore(model.store, selectSwitchingId);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const refresh = useCallback(() => void model.refresh(), [model]);
  const startNew = () => {
    setCreating(true);
    model.newSession().then(toast).finally(() => setCreating(false));
  };
  const renderItem = useCallback(
    ({ item }: { item: Session }) => (
      <Row s={item} model={model} switching={switchingId === item.session_id} anySwitching={switchingId !== null} editing={editing === item.session_id} setEditing={setEditing} />
    ),
    [model, switchingId, editing],
  );

  return (
    <View style={styles.screen}>
      <View style={styles.top}>
        <Button label="New conversation" icon="plus" variant="primary" onPress={startNew} busy={creating} />
      </View>
      {error ? <Text style={styles.error}>Couldn't load: {error}</Text> : null}
      <FlatList
        data={list}
        keyExtractor={keyOf}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.accent]} progressBackgroundColor={colors.surface} />}
        contentContainerStyle={styles.list}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={loading ? null : <Empty icon="history" title="No saved conversations yet" />}
      />
    </View>
  );
}

interface RowProps {
  s: Session;
  model: SessionsModel;
  switching: boolean;
  anySwitching: boolean;
  editing: boolean;
  setEditing: (id: string | null) => void;
}

const Row = memo(function Row({ s, model, switching, anySwitching, editing, setEditing }: RowProps) {
  const [title, setTitle] = useState(s.title ?? '');
  const [saving, setSaving] = useState(false);
  const name = s.title || `Untitled · ${s.session_id.slice(0, 8)}`;

  if (editing) {
    const save = () => {
      setSaving(true);
      model.rename(s.session_id, title).then((err) => {
        setSaving(false);
        if (err) toast(err);
        else setEditing(null);
      });
    };
    return (
      <View style={[styles.row, styles.editRow]}>
        <TextInput
          style={styles.input}
          value={title}
          onChangeText={setTitle}
          autoFocus
          maxLength={60}
          placeholder="Name"
          placeholderTextColor={colors.textDim}
          onSubmitEditing={save}
          returnKeyType="done"
        />
        <Button small label="Cancel" variant="ghost" onPress={() => setEditing(null)} />
        <Button small label="Save" variant="primary" onPress={save} busy={saving} />
      </View>
    );
  }

  const resume = () => {
    if (s.current || anySwitching) return;
    void model.resume(s.session_id).then(toast);
  };
  return (
    <Pressable style={[styles.row, s.current && styles.current]} onPress={resume} android_ripple={{ color: '#ffffff11' }} accessibilityRole="button" accessibilityHint={s.current ? undefined : 'Switch to this conversation'}>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.meta}>
          {s.updated ? timeAgo(s.updated) : ''}
          {s.current ? ' · current' : ''}
        </Text>
      </View>
      {switching ? <ActivityIndicator color={colors.accent} /> : null}
      <Pressable
        onPress={() => {
          setTitle(s.title ?? '');
          setEditing(s.session_id);
        }}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Rename ${name}`}
      >
        <Icon name="pencil-outline" size={20} color={colors.textDim} />
      </Pressable>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1 },
  top: { padding: space.m },
  error: { color: colors.danger, paddingHorizontal: space.m, paddingBottom: space.s },
  list: { paddingHorizontal: space.m, paddingBottom: space.l, gap: space.s, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m, overflow: 'hidden' },
  current: { borderWidth: 1, borderColor: colors.accent },
  editRow: { gap: space.s },
  body: { flex: 1 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  meta: { color: colors.textDim, fontSize: 13, marginTop: 2 },
  input: { flex: 1, color: colors.text, backgroundColor: colors.bg, borderRadius: radius.s, paddingHorizontal: space.s, paddingVertical: space.xs, fontSize: 15 },
});
