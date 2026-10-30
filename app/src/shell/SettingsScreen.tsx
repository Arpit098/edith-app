// Settings: the server connection, then each feature's settings section.

import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Connection, ConnectionState } from '../core/connection';
import type { SettingsSection } from '../core/feature';
import type { FrameMeter, FrameReport } from '../core/ports';
import { useStore } from '../core/store';
import { colors, space, type, useChrome, useGlass } from '../core/theme';
import { Button } from '../ui/Button';
import { Glass } from '../ui/Glass';
import { describeLink } from './ConnectionPill';

const selectState = (s: ConnectionState) => s;

export function SettingsScreen({ connection, sections, meter }: { connection: Connection; sections: SettingsSection[]; meter: FrameMeter | null }) {
  const state = useStore(connection.store, selectState);
  const chromeInsets = useChrome();
  const forget = () =>
    Alert.alert('Change server?', 'This disconnects and deletes the saved token from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => void connection.forget() },
    ]);
  return (
    <ScrollView contentContainerStyle={[styles.body, { paddingTop: chromeInsets.top + space.l, paddingBottom: chromeInsets.bottom + space.l }]}>
      <Glass level="regular" style={styles.section}>
        <Text style={styles.heading}>Server</Text>
        <Text style={styles.value} selectable>
          {state.baseUrl}
        </Text>
        <Text style={styles.dim}>{describeLink(state)}</Text>
        <View style={styles.actions}>
          {state.link !== 'open' ? <Button small label="Reconnect now" icon="refresh" onPress={() => connection.retry()} /> : null}
          <Button small label="Change server" icon="logout" variant="danger" onPress={forget} />
        </View>
      </Glass>
      {sections.map((s) => (
        <Glass key={s.title} level="regular" style={styles.section}>
          <Text style={styles.heading}>{s.title}</Text>
          <s.component />
        </Glass>
      ))}
      {meter ? <FrameSection meter={meter} /> : null}
    </ScrollView>
  );
}

export function describeFrames(r: FrameReport): string {
  return [
    `${r.frames} frames in ${r.seconds.toFixed(0)} s at ${r.refreshHz.toFixed(0)} Hz`,
    `p50 ${r.p50Ms.toFixed(1)} ms · p95 ${r.p95Ms.toFixed(1)} ms · p99 ${r.p99Ms.toFixed(1)} ms`,
    `janky ${r.jankyFrames} (${r.jankyPercent.toFixed(1)} %)`,
  ].join('\n');
}

/** Frame times while Arpit uses the app (scroll, switch tabs): how much the glass costs on this phone. */
function FrameSection({ meter }: { meter: FrameMeter }) {
  const { mode } = useGlass();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<FrameReport | null>(null);
  const toggle = () => {
    if (!running) {
      meter.start();
      setReport(null);
      setRunning(true);
      return;
    }
    setRunning(false);
    void meter.stop().then(setReport, () => setReport(null));
  };
  return (
    <Glass level="regular" style={styles.section}>
      <Text style={styles.heading}>Performance</Text>
      <Text style={styles.dim}>Glass: {mode === 'shader' ? 'refraction (Android 13+)' : mode === 'blur' ? 'blur (Android 12)' : 'flat'}</Text>
      {report ? (
        <Text style={styles.value} selectable>
          {describeFrames(report)}
        </Text>
      ) : (
        <Text style={styles.dim}>{running ? 'Measuring: scroll and switch tabs, then come back and stop.' : 'Measure frame times while you use the app.'}</Text>
      )}
      <View style={styles.actions}>
        <Button small label={running ? 'Stop measuring' : 'Measure frames'} icon={running ? 'stop' : 'speedometer'} onPress={toggle} />
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.l, gap: space.m },
  section: { padding: space.l, gap: space.xs },
  heading: { color: colors.textDim, fontSize: type.size.caption, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  value: { color: colors.text, fontSize: type.size.title },
  dim: { color: colors.textDim, fontSize: type.size.small },
  actions: { flexDirection: 'row', gap: space.s, marginTop: space.s, flexWrap: 'wrap' },
});
