// Settings → Updates: the running version, OTA status, and the new-APK flow; "Check for updates" is
// the page's pill.

import { StyleSheet, Text, View } from 'react-native';

import { formatBytes, formatIST } from '../../common/format';
import { useStore } from '../../core/store';
import { colors, space, type } from '../../core/theme';
import { Button } from '../../ui/Button';
import { CardBlock, Helper, PillButton, Row, Section, SettingsPageBody, SummaryCard } from '../../ui/SettingsRows';
import { apkAvailable, type AppUpdateModel, type AppUpdateState } from './model';
import { ReleaseNotes } from './ReleaseNotes';
import { updateSummary } from './summary';

const selectState = (s: AppUpdateState) => s;

function otaLine(s: AppUpdateState): string {
  if (!s.ota || !s.ota.enabled) return 'Code updates: off in this build (no signing key)';
  if (s.ota.rolledBack) return 'Code updates: the last one crashed at start, so EDITH went back to the previous one';
  if (s.ota.embedded || !s.ota.updateId) return 'Code: the version built into this APK';
  return `Code update ${s.ota.updateId.slice(0, 8)}${s.ota.createdAt ? ` from ${formatIST(s.ota.createdAt)}` : ''}`;
}

export function UpdateSection({ model }: { model: AppUpdateModel }) {
  const s = useStore(model.store, selectState);
  const available = apkAvailable(s);
  const busy = s.phase === 'downloading' || s.phase === 'installing';
  const upToDate = s.checkedAt && !available && !s.otaReady && !s.error && !s.checking;
  return (
    <SettingsPageBody>
      <SummaryCard
        icon="cellphone-arrow-down"
        title={s.installed ? `EDITH ${s.installed.versionName}` : 'EDITH'}
        subtitle={updateSummary(s) ?? 'Version unknown'}
        tone={available || s.otaReady ? 'warn' : upToDate ? 'ok' : s.error ? 'danger' : undefined}
      />

      {s.otaReady ? (
        <Section title="Ready to use">
          <CardBlock>
            <Text style={styles.text}>A newer version of the app’s code is ready. It’s used on the next start.</Text>
            <View style={styles.row}>
              <Button small label="Restart to update" icon="restart" variant="primary" busy={s.restarting} onPress={() => void model.restartToUpdate()} />
            </View>
          </CardBlock>
        </Section>
      ) : null}

      {available && s.latest ? (
        <Section title="Update available">
          <CardBlock>
            <Text style={styles.text}>
              EDITH {s.latest.versionName} (build {s.latest.versionCode}, {formatBytes(s.latest.size)}, {formatIST(s.latest.built_at)})
            </Text>
            <ReleaseNotes release={s.latest} />
            {s.phase === 'downloading' ? (
              <Text style={styles.dim}>
                Downloading {formatBytes(s.received)} of {formatBytes(s.total)} ({s.total ? Math.floor((100 * s.received) / s.total) : 0}%)
              </Text>
            ) : null}
            {s.message ? <Text style={[styles.dim, s.phase === 'failed' && styles.error]}>{s.message}</Text> : null}
            <View style={styles.row}>
              {s.phase === 'needs-permission' ? (
                <Button small label="Allow installs" icon="shield-check-outline" onPress={() => void model.allowInstalls()} />
              ) : (
                <Button small label={s.phase === 'failed' ? 'Try again' : 'Download and install'} icon="download" variant="primary" busy={busy} onPress={() => void model.install()} />
              )}
            </View>
          </CardBlock>
        </Section>
      ) : null}

      <Section title="This version" footer={upToDate ? 'Up to date.' : undefined}>
        <Row icon="information-outline" label="Version" value={s.installed ? `${s.installed.versionName} (build ${s.installed.versionCode})` : 'Unknown'} />
        <Row icon="code-braces" label="Code" sub={otaLine(s)} />
        <Row icon="clock-outline" label="Last checked" value={s.checkedAt ? formatIST(s.checkedAt) : 'Not yet'} />
      </Section>

      {s.error ? <Helper tone="error">{s.error}</Helper> : null}
      <PillButton label="Check for updates" icon="refresh" busy={s.checking} onPress={() => void model.check()} />
    </SettingsPageBody>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s, flexWrap: 'wrap' },
  text: { color: colors.text, fontSize: type.size.small },
  dim: { color: colors.textDim, fontSize: type.size.small },
  error: { color: colors.danger },
});
