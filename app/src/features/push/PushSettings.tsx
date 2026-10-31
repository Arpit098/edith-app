// Settings → Push: replies, approvals and reminders with the app closed (contracts/push.md). Off by
// default; "Turn on" fetches the phone's ntfy token from edith. Advanced: enter it by hand instead.

import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, space, type } from '../../core/theme';
import { useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import type { PushMode } from '../../core/ports';
import type { PushModel, PushState } from './model';

const selectStatus = (s: PushState) => s.status;
const selectError = (s: PushState) => s.error;
const selectFetching = (s: PushState) => s.fetching;

const MODES: { mode: PushMode; label: string; icon: string; hint: string }[] = [
  { mode: 'instant', label: 'Instant', icon: 'lightning-bolt-outline', hint: 'Stays connected: news arrives at once.' },
  { mode: 'poll', label: 'Every 15 min', icon: 'timer-outline', hint: 'Checks every 15 minutes (longer in deep sleep): less battery, news can be late.' },
];

const clock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function statusLine(status: PushState['status']): string {
  if (status.mode === 'poll') {
    if (status.error) return status.error;
    return status.connected && status.lastCheckAt
      ? `On: checks edith every 15 minutes. Last check ${clock(status.lastCheckAt)}.`
      : 'On: the first check comes within 15 minutes.';
  }
  return status.connected ? 'On: connected to edith’s push server.' : (status.error ?? 'On: connecting to edith’s push server…');
}

function ModePicker({ mode, onPick }: { mode: PushMode; onPick: (mode: PushMode) => void }) {
  return (
    <View style={styles.box}>
      <View style={styles.row} accessibilityRole="radiogroup">
        {MODES.map((m) => (
          <Button key={m.mode} small icon={m.icon} label={m.label} variant={m.mode === mode ? 'primary' : 'ghost'} onPress={() => m.mode !== mode && onPick(m.mode)} />
        ))}
      </View>
      <Text style={styles.dim}>{MODES.find((m) => m.mode === mode)!.hint}</Text>
    </View>
  );
}

export function PushSettings({ model, defaultUrl }: { model: PushModel; defaultUrl: string }) {
  const status = useStore(model.store, selectStatus);
  const error = useStore(model.store, selectError);
  const fetching = useStore(model.store, selectFetching);
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState('');
  const [mode, setMode] = useState<PushMode>('instant');
  const [advanced, setAdvanced] = useState(false);

  if (status.enabled) {
    const line = statusLine(status);
    const ok = status.connected && !status.error;
    return (
      <View style={styles.box}>
        <View style={styles.row} accessibilityLiveRegion="polite">
          <Icon name={ok ? 'check-circle-outline' : 'progress-clock'} size={18} color={ok ? colors.ok : status.error ? colors.warn : colors.textDim} />
          <Text style={[styles.text, styles.flex]}>{line}</Text>
        </View>
        <Text style={styles.dim}>Replies, approvals (with Allow and Deny) and reminders arrive with EDITH closed.</Text>
        <ModePicker mode={status.mode} onPick={model.setMode} />
        {status.mode === 'poll' || status.batteryUnrestricted ? null : (
          <View style={styles.banner}>
            <Text style={styles.text}>OxygenOS may stop the push connection to save battery. In EDITH’s app info, set Battery to Unrestricted.</Text>
            <View style={styles.row}>
              <Button small icon="open-in-new" label="Open app info" onPress={model.openBatterySettings} />
            </View>
          </View>
        )}
        <View style={styles.row}>
          <Button small icon="bell-off-outline" label="Turn off" variant="ghost" onPress={model.disable} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.box}>
      <Text style={styles.dim}>Get replies, approvals and reminders with EDITH closed, from edith’s own ntfy over Tailscale. Turning it on fetches the phone token from edith.</Text>
      <ModePicker mode={mode} onPick={setMode} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        <Button small variant="primary" icon="bell-ring-outline" label="Turn on" busy={fetching} onPress={() => void model.turnOn(mode)} />
        <Button small variant="ghost" icon={advanced ? 'chevron-up' : 'chevron-down'} label="Advanced" onPress={() => setAdvanced(!advanced)} />
      </View>
      {advanced ? (
        <View style={styles.box}>
          <Text style={styles.dim}>Or enter it by hand: the address of edith’s ntfy, and the token in ~/.config/edith/ntfy-phone-token on edith.</Text>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            placeholder="Push server address"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            accessibilityLabel="Push server"
          />
          <TextInput
            style={[styles.input, token ? styles.mono : null]}
            value={token}
            onChangeText={setToken}
            placeholder="Paste the phone token"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="Phone token"
          />
          <View style={styles.row}>
            <Button small icon="key-outline" label="Turn on with this token" disabled={fetching} onPress={() => model.enable(url, token, mode) && setToken('')} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.s, marginTop: space.xs },
  banner: { gap: space.s, padding: space.m, borderRadius: radius.m, borderWidth: 1, borderColor: colors.warn, backgroundColor: colors.cardRaised },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  flex: { flex: 1 },
  text: { color: colors.text, fontSize: 15 },
  dim: { color: colors.textDim, fontSize: 13 },
  error: { color: colors.danger, fontSize: 14 },
  input: { color: colors.text, backgroundColor: colors.card, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: 15, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  mono: { fontFamily: type.mono },
});
