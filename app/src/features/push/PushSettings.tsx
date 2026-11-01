// Settings → Push: replies, approvals and reminders with the app closed (contracts/push.md). Off by
// default; the switch at the top (or the Turn on pill) fetches the phone's ntfy token from edith.
// Advanced: enter it by hand instead. Instant or every 15 min is a segmented choice.

import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { clockIST } from '../../common/format';
import type { SettingsToggle } from '../../core/feature';
import type { PushMode } from '../../core/ports';
import { useStore } from '../../core/store';
import { colors, radius, space, type } from '../../core/theme';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { CardBlock, Helper, Notice, PillButton, Row, Section, SegmentRow, SettingsPageBody, SummaryCard } from '../../ui/SettingsRows';
import type { PushModel, PushState } from './model';

const selectState = (s: PushState) => s;

export const MODES: { id: PushMode; label: string; hint: string }[] = [
  { id: 'instant', label: 'Instant', hint: 'Stays connected: news arrives at once.' },
  { id: 'poll', label: 'Every 15 min', hint: 'Checks every 15 minutes (longer in deep sleep): less battery, news can be late.' },
];

const modeLabel = (m: PushMode) => MODES.find((x) => x.id === m)!.label;
const clock = (ms: number) => `${clockIST(ms / 1000)} IST`; // the phone's zone may not be IST

function statusLine(status: PushState['status']): string {
  if (status.mode === 'poll') {
    if (status.error) return status.error;
    return status.connected && status.lastCheckAt ? `On: checks edith every 15 minutes. Last check ${clock(status.lastCheckAt)}.` : 'On: the first check comes within 15 minutes.';
  }
  return status.connected ? 'On: connected to edith’s push server.' : (status.error ?? 'On: connecting to edith’s push server…');
}

/** The switch in the Settings list: on fetches the token (in the mode last used), off forgets it. */
export function pushToggle(model: PushModel, s: PushState): SettingsToggle {
  return {
    on: s.status.enabled,
    set: (on) => (on ? void model.turnOn(s.status.mode) : model.disable()),
    disabled: s.fetching,
    detail: s.status.enabled ? modeLabel(s.status.mode) : null,
  };
}

export function PushSettings({ model, defaultUrl }: { model: PushModel; defaultUrl: string }) {
  const { status, error, fetching } = useStore(model.store, selectState);
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState('');
  const [pending, setPending] = useState<PushMode>('instant'); // the mode to turn on with
  const [advanced, setAdvanced] = useState(false);
  const mode = status.enabled ? status.mode : pending;
  const ok = status.enabled && status.connected && !status.error;

  return (
    <SettingsPageBody>
      <SummaryCard
        icon="bell-outline"
        title="Push"
        subtitle={status.enabled ? statusLine(status) : fetching ? 'Asking edith for the push token…' : 'Off'}
        tone={!status.enabled ? undefined : ok ? 'ok' : status.error ? 'warn' : undefined}
        toggle={{ value: status.enabled, label: 'Push', disabled: fetching, onChange: (on) => (on ? void model.turnOn(mode) : model.disable()) }}
      />
      {error ? <Helper tone="error">{error}</Helper> : null}

      <Section title="Delivery" footer={`${MODES.find((m) => m.id === mode)!.hint} Replies, approvals (with Allow and Deny) and reminders arrive with EDITH closed.`}>
        <SegmentRow label="How news arrives" icon="lightning-bolt-outline" options={MODES} value={mode} onChange={status.enabled ? model.setMode : setPending} />
      </Section>

      {status.enabled && status.mode === 'instant' && !status.batteryUnrestricted ? (
        <Notice
          text="OxygenOS may stop the push connection to save battery. In EDITH’s app info, set Battery to Unrestricted."
          action={
            <View style={styles.row}>
              <Button small icon="open-in-new" label="Open app info" onPress={model.openBatterySettings} />
            </View>
          }
        />
      ) : null}

      {status.enabled ? null : (
        <>
          <Section title="Advanced" footer={advanced ? 'The address of edith’s ntfy, and the token in ~/.config/edith/ntfy-phone-token on edith.' : undefined}>
            <Row icon="key-outline" label="Enter the token by hand" accessibilityLabel="Advanced" onPress={() => setAdvanced(!advanced)} chevron={false} trailing={<Chevron open={advanced} />} />
            {advanced ? (
              <CardBlock>
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
              </CardBlock>
            ) : null}
          </Section>
          <PillButton label="Turn on" icon="bell-ring-outline" variant="primary" busy={fetching} onPress={() => void model.turnOn(mode)} accessibilityHint="Fetches the phone token from edith" />
        </>
      )}
    </SettingsPageBody>
  );
}

function Chevron({ open }: { open: boolean }) {
  return <Icon name={open ? 'chevron-up' : 'chevron-down'} size={20} color={colors.textFaint} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  input: { color: colors.text, backgroundColor: colors.input, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s, fontSize: type.size.body, minHeight: 44 },
  mono: { fontFamily: type.mono },
});
