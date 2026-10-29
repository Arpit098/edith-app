// Settings: the server connection, then each feature's settings section.

import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Connection, ConnectionState } from '../core/connection';
import type { SettingsSection } from '../core/feature';
import { useStore } from '../core/store';
import { Button } from '../ui/Button';
import { colors, radius, space } from '../ui/theme';
import { describeLink } from './ConnectionPill';

const selectState = (s: ConnectionState) => s;

export function SettingsScreen({ connection, sections }: { connection: Connection; sections: SettingsSection[] }) {
  const state = useStore(connection.store, selectState);
  const forget = () =>
    Alert.alert('Change server?', 'This disconnects and deletes the saved token from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => void connection.forget() },
    ]);
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <View style={styles.section}>
        <Text style={styles.heading}>Server</Text>
        <Text style={styles.value} selectable>
          {state.baseUrl}
        </Text>
        <Text style={styles.dim}>{describeLink(state)}</Text>
        <View style={styles.actions}>
          {state.link !== 'open' ? <Button small label="Reconnect now" icon="refresh" onPress={() => connection.retry()} /> : null}
          <Button small label="Change server" icon="logout" variant="danger" onPress={forget} />
        </View>
      </View>
      {sections.map((s) => (
        <View key={s.title} style={styles.section}>
          <Text style={styles.heading}>{s.title}</Text>
          <s.component />
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.m, gap: space.m },
  section: { backgroundColor: colors.surface, borderRadius: radius.m, padding: space.m, gap: space.xs },
  heading: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { color: colors.text, fontSize: 16 },
  dim: { color: colors.textDim, fontSize: 13 },
  actions: { flexDirection: 'row', gap: space.s, marginTop: space.s, flexWrap: 'wrap' },
});
