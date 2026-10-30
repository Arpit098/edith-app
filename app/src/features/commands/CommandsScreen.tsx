import { memo, useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Command } from '../../core/api';
import { useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { ReplyButtons } from '../../ui/ReplyButtons';
import { colors, radius, space, type, useChrome } from '../../core/theme';
import { toast } from '../../ui/toast';
import type { CommandsModel, CommandsState, OutputEntry } from './model';

const selectOutput = (s: CommandsState) => s.output;
const selectCommands = (s: CommandsState) => s.commands;
const selectLoading = (s: CommandsState) => s.loading;
const selectError = (s: CommandsState) => s.error;
const selectRunning = (s: CommandsState) => s.running;
const keyOf = (o: OutputEntry) => String(o.id);

export function CommandsScreen({ model }: { model: CommandsModel }) {
  const output = useStore(model.store, selectOutput);
  const chromeInsets = useChrome();
  useEffect(() => void model.load(), [model]);
  const renderItem = useCallback(({ item }: { item: OutputEntry }) => <OutputCard entry={item} model={model} />, [model]);
  return (
    <FlatList
      data={output}
      keyExtractor={keyOf}
      renderItem={renderItem}
      ListHeaderComponent={<Picker model={model} />}
      contentContainerStyle={[styles.list, { paddingTop: chromeInsets.top + space.m, paddingBottom: chromeInsets.bottom + space.l }]}
      keyboardShouldPersistTaps="handled"
    />
  );
}

const Picker = memo(function Picker({ model }: { model: CommandsModel }) {
  const commands = useStore(model.store, selectCommands);
  const loading = useStore(model.store, selectLoading);
  const error = useStore(model.store, selectError);
  const running = useStore(model.store, selectRunning);
  const [picked, setPicked] = useState<Command | null>(null);
  const [args, setArgs] = useState('');

  const run = (c: Command, a = '') => void model.run(c.name, a).then((err) => (err ? toast(err) : (setPicked(null), setArgs(''))));
  const tap = (c: Command) => (c.usage ? setPicked(picked?.name === c.name ? null : c) : run(c));

  if (!commands) {
    return (
      <View style={styles.center}>
        {loading ? <ActivityIndicator color={colors.accent} /> : null}
        {error ? (
          <>
            <Text style={styles.error}>Couldn't load the commands: {error}</Text>
            <Button label="Try again" small onPress={() => void model.load(true)} />
          </>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.picker}>
      <View style={styles.chips}>
        {commands.map((c) => (
          <Pressable
            key={c.name}
            onPress={() => tap(c)}
            disabled={!!running}
            style={[styles.chip, picked?.name === c.name && styles.chipOn]}
            accessibilityRole="button"
            accessibilityHint={c.description}
          >
            {running === c.name ? <ActivityIndicator size="small" color={colors.accent} /> : null}
            <Text style={styles.chipText}>/{c.name}</Text>
          </Pressable>
        ))}
      </View>
      {picked ? (
        <View style={styles.argsBox}>
          <Text style={styles.help}>
            /{picked.name} {picked.usage} — {picked.description}
          </Text>
          <View style={styles.argsRow}>
            <TextInput
              style={styles.input}
              value={args}
              onChangeText={setArgs}
              autoFocus
              placeholder={picked.usage}
              placeholderTextColor={colors.textDim}
              onSubmitEditing={() => run(picked, args)}
              returnKeyType="send"
            />
            <Button icon="play" variant="primary" onPress={() => run(picked, args)} busy={running === picked.name} accessibilityLabel={`Run /${picked.name}`} />
          </View>
        </View>
      ) : null}
    </View>
  );
});

const OutputCard = memo(function OutputCard({ entry, model }: { entry: OutputEntry; model: CommandsModel }) {
  return (
    <View style={styles.card}>
      {entry.command ? <Text style={styles.cmd}>/{entry.command}</Text> : null}
      <Text style={styles.text} selectable>
        {entry.text}
      </Text>
      {entry.note ? <Text style={styles.note}>{entry.note}</Text> : null}
      <ReplyButtons rows={entry.buttons} onPress={(action) => model.press(entry.id, action).then(toast)} />
    </View>
  );
});

const styles = StyleSheet.create({
  list: { paddingHorizontal: space.l, gap: space.s },
  center: { alignItems: 'center', gap: space.m, padding: space.l },
  error: { color: colors.danger, textAlign: 'center' },
  picker: { gap: space.m, marginBottom: space.s },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs, backgroundColor: colors.card, borderRadius: radius.pill, paddingHorizontal: space.m, paddingVertical: space.s, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  chipOn: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: type.size.small },
  argsBox: { gap: space.s },
  help: { color: colors.textDim, fontSize: 13 },
  argsRow: { flexDirection: 'row', gap: space.s, alignItems: 'center' },
  input: { flex: 1, color: colors.text, backgroundColor: colors.input, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: type.size.body, minHeight: 44 },
  card: { backgroundColor: colors.card, borderRadius: radius.m, padding: space.m, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  cmd: { color: colors.accent, fontSize: 12, marginBottom: space.xs },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  note: { color: colors.textDim, fontSize: 13, marginTop: space.xs },
});
