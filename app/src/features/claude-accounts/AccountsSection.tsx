// Settings → Claude accounts: the saved logins (the one in use marked), Switch (confirmed: it restarts
// EDITH and the agents), its progress, Add (open Claude's sign-in, paste the code back), Rename (the
// pencil, or a long press on the row: a small dialog) and Remove.

import { useState } from 'react';
import { Alert, Linking, Modal, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ClaudeAccount } from '../../core/api';
import { useStore } from '../../core/store';
import { colors, radius, space, type } from '../../core/theme';
import { Button } from '../../ui/Button';
import { CardBlock, Helper, PillButton, Row, Section, SettingsPageBody, SummaryCard } from '../../ui/SettingsRows';
import { LABEL_MAX, labelProblem, switchLine, type AccountsModel, type AccountsState } from './model';
import { accountsSummary } from './summary';

const selectState = (s: AccountsState) => s;

export function AccountsSection({ model }: { model: AccountsModel }) {
  const s = useStore(model.store, selectState);
  const switching = s.switch?.state === 'running';
  const [renaming, setRenaming] = useState<ClaudeAccount | null>(null);

  const confirmSwitch = (a: ClaudeAccount) =>
    Alert.alert(
      `Switch to ${a.label}?`,
      'This restarts EDITH and the coding agents on this account. The chat drops for about 30 seconds; their conversations carry on.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Switch', onPress: () => void model.switchTo(a.id) },
      ],
    );
  const confirmRemove = (a: ClaudeAccount) =>
    Alert.alert(`Remove ${a.label}?`, 'Its saved login is deleted from the server. You can add it again later.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void model.remove(a.id) },
    ]);
  const add = async () => {
    const url = await model.startLogin();
    if (url) Linking.openURL(url).catch(() => undefined); // the link is also shown, to copy
  };

  const active = s.accounts.find((a) => a.active);
  return (
    <SettingsPageBody>
      <SummaryCard
        icon="account-multiple-outline"
        title={active ? active.label : 'Claude accounts'}
        subtitle={accountsSummary(s) ?? 'Loading…'}
        tone={switching ? 'warn' : s.error ? 'danger' : active ? 'ok' : undefined}
      />

      <Section title="Accounts" footer="Long press an account to rename it. Switching restarts EDITH and the coding agents.">
        {s.accounts.map((a) => (
          <Row
            key={a.id}
            icon={a.active ? 'check-circle' : 'account-circle-outline'}
            iconColor={a.active ? colors.ok : undefined}
            label={a.label}
            sub={[a.email !== a.label ? a.email : null, a.plan ? `${a.plan[0]!.toUpperCase()}${a.plan.slice(1)}` : null, a.active ? 'in use' : null].filter(Boolean).join(' · ')}
            accessibilityLabel={`${a.label}${a.active ? ', in use' : ''}`}
            accessibilityHint="Long press to rename"
            onLongPress={() => setRenaming(a)}
            longPressLabel="Rename"
            chevron={false}
            trailing={
              <View style={styles.actions}>
                <Button small icon="pencil-outline" variant="ghost" accessibilityLabel={`Rename ${a.label}`} disabled={s.busy !== null} onPress={() => setRenaming(a)} />
                {a.active ? null : (
                  <>
                    <Button small label="Switch" icon="swap-horizontal" variant="primary" disabled={switching || s.busy !== null} busy={s.busy === 'switch'} onPress={() => confirmSwitch(a)} />
                    <Button small icon="delete-outline" variant="ghost" accessibilityLabel={`Remove ${a.label}`} disabled={switching || s.busy !== null} onPress={() => confirmRemove(a)} />
                  </>
                )}
              </View>
            }
          />
        ))}
        {!s.loaded && !s.error ? <Row icon="progress-clock" label="Loading…" /> : null}
        <Row icon="refresh" label="Refresh" tone="accent" chevron={false} busy={s.busy === 'refresh'} onPress={() => void model.refresh()} />
      </Section>
      {renaming ? <RenameDialog model={model} account={renaming} busy={s.busy === 'rename'} onClose={() => setRenaming(null)} /> : null}

      {s.switch ? (
        <View style={styles.status} accessibilityLiveRegion="polite">
          <Text style={[styles.text, s.switch.state === 'failed' && styles.error, s.switch.state === 'rolled_back' && styles.warn]}>{switchLine(s.switch, s.accounts)}</Text>
          {switching && s.switch.agents.length ? <Helper>{`Restarting EDITH and ${s.switch.agents.join(', ')}`}</Helper> : null}
        </View>
      ) : null}

      {s.error ? <Helper tone="error">{s.error}</Helper> : null}

      {s.login ? (
        <Section title="Add an account">
          <LoginForm model={model} url={s.login.url} busy={s.busy === 'code'} />
        </Section>
      ) : (
        <PillButton label="Add account" icon="account-plus-outline" variant="primary" disabled={switching} busy={s.busy === 'login'} onPress={() => void add()} />
      )}
    </SettingsPageBody>
  );
}

function RenameDialog({ model, account, busy, onClose }: { model: AccountsModel; account: ClaudeAccount; busy: boolean; onClose: () => void }) {
  const [label, setLabel] = useState(account.label);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    const why = labelProblem(label);
    if (why) return setProblem(why);
    if (label.trim() === account.label) return onClose();
    if (await model.rename(account.id, label)) onClose();
    else setProblem(model.store.get().error);
  };
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        <View style={styles.dialog} accessibilityViewIsModal>
          <Text style={styles.value}>Rename account</Text>
          <Text style={styles.dim} numberOfLines={1}>
            {account.email ?? account.label}
          </Text>
          <TextInput
            style={styles.input}
            value={label}
            onChangeText={(t) => {
              setLabel(t);
              setProblem(null);
            }}
            placeholder="Name, e.g. Work"
            placeholderTextColor={colors.textFaint}
            maxLength={LABEL_MAX + 10}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            onSubmitEditing={() => void save()}
            accessibilityLabel="New name"
          />
          {problem ? <Text style={[styles.text, styles.error]}>{problem}</Text> : null}
          <View style={[styles.row, styles.end]}>
            <Button small label="Cancel" variant="ghost" disabled={busy} onPress={onClose} />
            <Button small label="Save" icon="check" variant="primary" disabled={!label.trim()} busy={busy} onPress={() => void save()} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function LoginForm({ model, url, busy }: { model: AccountsModel; url: string; busy: boolean }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const done = async () => {
    if (await model.finishLogin(code, label)) {
      setCode('');
      setLabel('');
    }
  };
  return (
    <CardBlock>
      <Text style={styles.text}>Sign in to the other Claude account on this page, then paste the code it shows below.</Text>
      <Text style={[styles.dim, styles.link]} selectable numberOfLines={3}>
        {url}
      </Text>
      <Button small label="Open sign-in page" icon="open-in-new" onPress={() => void Linking.openURL(url).catch(() => undefined)} />
      <TextInput style={styles.input} value={code} onChangeText={setCode} placeholder="Paste the code" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Sign-in code" />
      <TextInput style={styles.input} value={label} onChangeText={setLabel} placeholder="Name (optional), e.g. Work" placeholderTextColor={colors.textFaint} maxLength={LABEL_MAX} accessibilityLabel="Account name" />
      <View style={styles.row}>
        <Button small label="Save account" icon="check" variant="primary" disabled={!code.trim()} busy={busy} onPress={() => void done()} />
        <Button small label="Cancel" disabled={busy} onPress={() => void model.cancelLogin()} />
      </View>
    </CardBlock>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  status: { gap: space.xs, paddingHorizontal: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s, flexWrap: 'wrap' },
  end: { justifyContent: 'flex-end' },
  scrim: { flex: 1, justifyContent: 'center', padding: space.l, backgroundColor: colors.scrim },
  dialog: { gap: space.s, padding: space.l, borderRadius: radius.l, backgroundColor: colors.cardRaised },
  value: { color: colors.text, fontSize: type.size.body },
  text: { color: colors.text, fontSize: type.size.small },
  dim: { color: colors.textDim, fontSize: type.size.small },
  link: { fontFamily: type.mono },
  error: { color: colors.danger },
  warn: { color: colors.warn },
  input: { color: colors.text, backgroundColor: colors.input, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: type.size.body, minHeight: 44 },
});
