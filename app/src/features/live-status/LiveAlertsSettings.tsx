// Settings → Live Alerts: a banner while Live Updates are off for EDITH (OxygenOS asks for each app,
// and the pill never shows without it), the way to that switch, and a test of the pill.

import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AppVisibility, OngoingStatus } from '../../core/ports';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { colors, radius, space } from '../../core/theme';

export function LiveAlertsSettings({ status, visibility }: { status: OngoingStatus; visibility?: AppVisibility }) {
  const [allowed, setAllowed] = useState(() => status.canPromote());
  // Back from Android's settings: read the switch again.
  useEffect(() => visibility?.onChange((active) => active && setAllowed(status.canPromote())), [status, visibility]);
  const off = status.liveUpdates && !allowed;
  return (
    <View style={styles.box}>
      {off ? (
        <View style={styles.banner} accessibilityRole="alert">
          <View style={styles.row}>
            <Icon name="alert-circle-outline" size={20} color={colors.warn} />
            <Text style={[styles.text, styles.flex]}>Live Updates are off for EDITH, so its status can’t show in the Live Alerts pill.</Text>
          </View>
          <View style={styles.row}>
            <Button small variant="primary" icon="open-in-new" label="Turn on Live Updates" onPress={() => status.openPromotionSettings()} />
          </View>
        </View>
      ) : (
        <Text style={styles.dim}>
          {status.liveUpdates ? 'EDITH’s status shows in the Live Alerts pill while a task runs.' : 'This phone shows EDITH’s status as an ongoing notification (Live Alerts need Android 16).'}
        </Text>
      )}
      <View style={styles.row}>
        <Button small icon="play-circle-outline" label="Test island" onPress={() => status.testIsland()} />
        <Text style={[styles.dim, styles.flex]}>Shows a 30 s demo. Leave the app to see the pill.</Text>
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
});
