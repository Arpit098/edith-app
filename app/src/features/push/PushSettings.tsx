// Settings → Push: replies, approvals and reminders with the app closed (contracts/push.md). Off by
// default; turned on with the phone's ntfy token from edith (deploy/ntfy/README.md).

import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, space, type } from '../../core/theme';
import { useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import type { PushModel, PushState } from './model';

const selectStatus = (s: PushState) => s.status;
const selectError = (s: PushState) => s.error;

export function PushSettings({ model, defaultUrl }: { model: PushModel; defaultUrl: string }) {
  const status = useStore(model.store, selectStatus);
  const error = useStore(model.store, selectError);
  const [url, setUrl] = useState(defaultUrl);
  const [token, setToken] = useState('');

  if (status.enabled) {
    const line = status.connected ? 'On: connected to edith’s push server.' : (status.error ?? 'On: connecting to edith’s push server…');
    return (
      <View style={styles.box}>
        <View style={styles.row} accessibilityLiveRegion="polite">
          <Icon name={status.connected ? 'check-circle-outline' : 'progress-clock'} size={18} color={status.connected ? colors.ok : status.error ? colors.warn : colors.textDim} />
          <Text style={[styles.text, styles.flex]}>{line}</Text>
        </View>
        <Text style={styles.dim}>Replies, approvals (with Allow and Deny) and reminders arrive with EDITH closed.</Text>
        {status.batteryUnrestricted ? null : (
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
      <Text style={styles.dim}>Get replies, approvals and reminders with EDITH closed, from edith’s own ntfy over Tailscale. Off until you add the phone token.</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="http://100.x.y.z:2586"
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="Push server"
      />
      <TextInput
        style={[styles.input, styles.mono]}
        value={token}
        onChangeText={setToken}
        placeholder="from ~/.config/edith/ntfy-phone-token on edith"
        placeholderTextColor={colors.textDim}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        accessibilityLabel="Phone token"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        <Button small variant="primary" icon="bell-ring-outline" label="Turn on" onPress={() => model.enable(url, token) && setToken('')} />
      </View>
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
