// Settings: the server connection, then each feature's settings section.

import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Connection, ConnectionState } from '../core/connection';
import type { SettingsSection } from '../core/feature';
import { useStore } from '../core/store';
import { colors, space, type, useChrome } from '../core/theme';
import { Button } from '../ui/Button';
import { Glass } from '../ui/Glass';
import { describeLink } from './ConnectionPill';

const selectState = (s: ConnectionState) => s;

export function SettingsScreen({ connection, sections }: { connection: Connection; sections: SettingsSection[] }) {
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
    </ScrollView>
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
