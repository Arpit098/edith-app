// The Commands page, laid out like Settings (ui/SettingsRows): a search field, then sections of
// compact rows (icon, name, one line on what it does, the /command in dim monospace), then the
// replies. A tap runs the command, opens its argument field when it takes one, or asks first when
// it interrupts EDITH (/restart).

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { Command } from '../../core/api';
import { useStore } from '../../core/store';
import { colors, radius, space, themedStyles, type, useChrome } from '../../core/theme';
import { Button } from '../../ui/Button';
import { Glass } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { ReplyButtons } from '../../ui/ReplyButtons';
import { CardBlock, Helper, Row, Section, SettingsPageBody } from '../../ui/SettingsRows';
import { toast } from '../../ui/toast';
import { sections, type CommandRow } from './catalog';
import type { CommandsModel, CommandsState, OutputEntry } from './model';

const selectOutput = (s: CommandsState) => s.output;
const selectCommands = (s: CommandsState) => s.commands;
const selectLoading = (s: CommandsState) => s.loading;
const selectError = (s: CommandsState) => s.error;
const selectRunning = (s: CommandsState) => s.running;
const selectRecent = (s: CommandsState) => s.recent;
const keyOf = (o: OutputEntry) => String(o.id);

export function CommandsScreen({ model }: { model: CommandsModel }) {
  const output = useStore(model.store, selectOutput);
  const chromeInsets = useChrome();
  const list = useRef<FlatList<OutputEntry>>(null);
  useEffect(() => void model.load(), [model]);
  // A new reply lands under the list of commands: bring it into view.
  const newest = output[0]?.id;
  const seen = useRef(newest);
  useEffect(() => {
    if (newest === undefined || newest === seen.current) return;
    seen.current = newest;
    list.current?.scrollToIndex({ index: 0, viewOffset: chromeInsets.top + space.m, animated: true });
  }, [newest, chromeInsets.top]);
  const onScrollToIndexFailed = useCallback(() => list.current?.scrollToEnd({ animated: true }), []);
  const renderItem = useCallback(({ item }: { item: OutputEntry }) => <OutputCard entry={item} model={model} />, [model]);
  return (
    <FlatList
      ref={list}
      data={output}
      keyExtractor={keyOf}
      renderItem={renderItem}
      ListHeaderComponent={<Picker model={model} replies={output.length > 0} />}
      contentContainerStyle={[styles.list, { paddingTop: chromeInsets.top + space.m, paddingBottom: chromeInsets.bottom + space.l }]}
      keyboardShouldPersistTaps="handled"
      onScrollToIndexFailed={onScrollToIndexFailed}
    />
  );
}

const Picker = memo(function Picker({ model, replies }: { model: CommandsModel; replies: boolean }) {
  const commands = useStore(model.store, selectCommands);
  const loading = useStore(model.store, selectLoading);
  const error = useStore(model.store, selectError);
  const running = useStore(model.store, selectRunning);
  const recent = useStore(model.store, selectRecent);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string | null>(null); // "section:command" whose argument field is open
  const [args, setArgs] = useState('');
  const ts = useStyles();
  const groups = useMemo(() => (commands ? sections(commands, query, recent) : []), [commands, query, recent]);

  const run = useCallback(
    (c: Command, a = '') =>
      void model.run(c.name, a).then((err) => {
        if (err) return toast(err);
        setPicked(null);
        setArgs('');
      }),
    [model],
  );
  const tap = useCallback(
    ({ command: c, meta }: CommandRow, key: string) => {
      if (c.usage) {
        setArgs('');
        setPicked((p) => (p === key ? null : key));
      } else if (meta.confirm) {
        Alert.alert(meta.confirm.title, meta.confirm.message, [
          { text: 'Cancel', style: 'cancel' },
          { text: meta.confirm.action, style: 'destructive', onPress: () => run(c) },
        ]);
      } else run(c);
    },
    [run],
  );

  if (!commands) {
    return (
      <View style={styles.center}>
        {loading ? <ActivityIndicator color={ts.accent.color} /> : null}
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
      <SettingsPageBody>
        <SearchField value={query} onChange={setQuery} />
        {groups.map((g) => (
          <Section key={g.id} title={g.title}>
            {g.rows.flatMap((r) => {
              const c = r.command;
              const key = `${g.id}:${c.name}`; // a recent command is also in its group: open only the one tapped
              const open = picked === key;
              const row = (
                <Row
                  key={c.name}
                  icon={r.meta.icon}
                  label={r.meta.title}
                  sub={r.meta.description || null}
                  value={`/${c.name}`}
                  mono
                  chevron={false}
                  onPress={() => tap(r, key)}
                  busy={running === c.name}
                  expanded={c.usage ? open : undefined}
                  tone={r.meta.confirm ? 'danger' : undefined}
                  accessibilityLabel={[`${r.meta.title}, /${c.name}`, r.meta.description].filter(Boolean).join('. ')}
                  accessibilityHint={c.usage ? `Opens a field for ${c.usage}` : r.meta.confirm ? 'Asks before running it' : 'Runs it'}
                />
              );
              return open ? [row, <ArgsBlock key={`${c.name}-args`} command={c} args={args} setArgs={setArgs} run={run} busy={running === c.name} />] : [row];
            })}
          </Section>
        ))}
        {!groups.length ? <Helper>No commands match “{query.trim()}”.</Helper> : null}
        {replies ? (
          <View style={styles.repliesHead}>
            <Text style={styles.repliesTitle} accessibilityRole="header">
              Replies
            </Text>
            <Button label="Clear" small onPress={model.clear} accessibilityLabel="Clear replies" />
          </View>
        ) : null}
      </SettingsPageBody>
    </View>
  );
});

function ArgsBlock({ command: c, args, setArgs, run, busy }: { command: Command; args: string; setArgs: (s: string) => void; run: (c: Command, a: string) => void; busy: boolean }) {
  return (
    <CardBlock>
      <Text style={styles.help}>
        /{c.name} {c.usage}
      </Text>
      <View style={styles.argsRow}>
        <TextInput
          style={styles.input}
          value={args}
          onChangeText={setArgs}
          autoFocus
          placeholder={c.usage}
          placeholderTextColor={colors.textDim}
          onSubmitEditing={() => run(c, args)}
          returnKeyType="send"
          accessibilityLabel={`What to send with /${c.name}`}
        />
        <Button icon="play" variant="primary" onPress={() => run(c, args)} busy={busy} accessibilityLabel={`Run /${c.name}`} />
      </View>
    </CardBlock>
  );
}

function SearchField({ value, onChange }: { value: string; onChange: (s: string) => void }) {
  return (
    <Glass level="regular" rim radius={radius.pill} style={styles.search}>
      <Icon name="magnify" size={20} color={colors.textDim} />
      <TextInput
        style={styles.searchInput}
        value={value}
        onChangeText={onChange}
        placeholder="Search commands"
        placeholderTextColor={colors.textDim}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        accessibilityLabel="Search commands"
      />
      {value ? (
        <Pressable onPress={() => onChange('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear search">
          <Icon name="close-circle" size={18} color={colors.textDim} />
        </Pressable>
      ) : null}
    </Glass>
  );
}

const OutputCard = memo(function OutputCard({ entry, model }: { entry: OutputEntry; model: CommandsModel }) {
  const ts = useStyles();
  return (
    <View style={styles.card}>
      {entry.command ? <Text style={[styles.cmd, ts.accent]}>/{entry.command}</Text> : null}
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
  picker: { marginBottom: space.s },
  search: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.l, minHeight: 48 },
  searchInput: { flex: 1, color: colors.text, fontSize: type.size.body, paddingVertical: space.s },
  help: { color: colors.textDim, fontSize: type.size.small, fontFamily: type.mono },
  argsRow: { flexDirection: 'row', gap: space.s, alignItems: 'center' },
  input: { flex: 1, color: colors.text, backgroundColor: colors.input, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: type.size.body, minHeight: 44 },
  repliesHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.xs },
  repliesTitle: { color: colors.text, fontSize: type.size.body, fontWeight: '600' },
  card: { backgroundColor: colors.card, borderRadius: radius.m, padding: space.m, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  cmd: { fontSize: 12, marginBottom: space.xs },
  text: { color: colors.text, fontSize: 15, lineHeight: 21 },
  note: { color: colors.textDim, fontSize: 13, marginTop: space.xs },
});

const useStyles = themedStyles((t) =>
  StyleSheet.create({
    accent: { color: t.accent },
  }),
);
