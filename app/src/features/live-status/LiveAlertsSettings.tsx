// Settings → Live Alerts: a banner while Live Updates are off for EDITH (OxygenOS asks for each app,
// and the pill never shows without it), the way to that switch, and a test of the pill that says
// what happened (the demo is silent and the pill hides while EDITH is open, so without words a
// working test looks like nothing).

import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { AppVisibility, OngoingStatus } from '../../core/ports';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { colors, radius, space } from '../../ui/theme';

export function LiveAlertsSettings({ status, visibility }: { status: OngoingStatus; visibility?: AppVisibility }) {
  const [allowed, setAllowed] = useState(() => status.canPromote());
  // Back from Android's settings: read the switch again.
  useEffect(() => visibility?.onChange((active) => active && setAllowed(status.canPromote())), [status, visibility]);
  const off = status.liveUpdates && !allowed;
  const [demo, setDemo] = useState<{ ok: boolean; message: string } | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (clearTimer.current && clearTimeout(clearTimer.current)), []);
  const test = () => {
    let result: { ok: boolean; message: string };
    try {
      result = status.testIsland();
    } catch (e) {
      result = { ok: false, message: `Couldn’t run the demo: ${e instanceof Error ? e.message : String(e)}` };
    }
    setDemo(result);
    setAllowed(status.canPromote());
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = result.ok ? setTimeout(() => setDemo(null), DEMO_MS) : null; // the demo's own 30 s
  };
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
        <Button small icon="play-circle-outline" label="Test island" onPress={test} />
        <Text style={[styles.dim, styles.flex]}>Shows a 30 s demo. Leave the app to see the pill.</Text>
      </View>
      {demo ? (
        <View style={styles.row} accessibilityLiveRegion="polite">
          <Icon name={demo.ok ? 'check-circle-outline' : 'alert-circle-outline'} size={18} color={demo.ok ? colors.ok : colors.danger} />
          <Text style={[demo.ok ? styles.text : styles.error, styles.flex]}>{demo.message}</Text>
        </View>
      ) : null}
    </View>
  );
}

const DEMO_MS = 30_000;

const styles = StyleSheet.create({
  box: { gap: space.s, marginTop: space.xs },
  banner: { gap: space.s, padding: space.m, borderRadius: radius.m, borderWidth: 1, borderColor: colors.warn, backgroundColor: colors.surfaceHigh },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  flex: { flex: 1 },
  text: { color: colors.text, fontSize: 15 },
  dim: { color: colors.textDim, fontSize: 13 },
  error: { color: colors.danger, fontSize: 15 },
});
