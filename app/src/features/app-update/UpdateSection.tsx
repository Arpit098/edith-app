// Settings → Updates: the running version, OTA status, and the new-APK flow.

import { StyleSheet, Text, View } from 'react-native';

import { formatBytes, formatIST } from '../../common/format';
import { useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { colors, space } from '../../core/theme';
import { apkAvailable, type AppUpdateModel, type AppUpdateState } from './model';
import { ReleaseNotes } from './ReleaseNotes';

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
  return (
    <View style={styles.box}>
      <Text style={styles.value}>{s.installed ? `EDITH ${s.installed.versionName} (build ${s.installed.versionCode})` : 'EDITH (version unknown)'}</Text>
      <Text style={styles.dim}>{otaLine(s)}</Text>

      {s.otaReady ? (
        <View style={styles.block}>
          <Text style={styles.text}>A newer version of the app’s code is ready. It’s used on the next start.</Text>
          <Button small label="Restart now" icon="restart" variant="primary" onPress={() => void model.applyOta()} />
        </View>
      ) : null}

      {available && s.latest ? (
        <View style={styles.block}>
          <Text style={styles.text}>
            Update available: EDITH {s.latest.versionName} (build {s.latest.versionCode}, {formatBytes(s.latest.size)}, {formatIST(s.latest.built_at)})
          </Text>
          <ReleaseNotes release={s.latest} />
          {s.phase === 'downloading' ? (
            <Text style={styles.dim}>
              Downloading {formatBytes(s.received)} of {formatBytes(s.total)} ({s.total ? Math.floor((100 * s.received) / s.total) : 0}%)
            </Text>
          ) : null}
          {s.message ? <Text style={[styles.dim, s.phase === 'failed' && styles.error]}>{s.message}</Text> : null}
          {s.phase === 'needs-permission' ? (
            <Button small label="Allow installs" icon="shield-check-outline" onPress={() => void model.allowInstalls()} />
          ) : (
            <Button small label={s.phase === 'failed' ? 'Try again' : 'Download and install'} icon="download" variant="primary" busy={busy} onPress={() => void model.install()} />
          )}
        </View>
      ) : null}

      {s.error ? <Text style={[styles.dim, styles.error]}>{s.error}</Text> : null}
      <View style={styles.row}>
        <Button small label="Check for updates" icon="refresh" busy={s.checking} onPress={() => void model.check()} />
        {s.checkedAt ? <Text style={styles.dim}>Checked {formatIST(s.checkedAt)}</Text> : null}
      </View>
      {s.checkedAt && !available && !s.otaReady && !s.error && !s.checking ? <Text style={styles.dim}>Up to date.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.xs },
  block: { gap: space.s, marginTop: space.s, paddingTop: space.s, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s, marginTop: space.s, flexWrap: 'wrap' },
  value: { color: colors.text, fontSize: 16 },
  text: { color: colors.text, fontSize: 14 },
  dim: { color: colors.textDim, fontSize: 13 },
  error: { color: colors.danger },
});
