// Settings → Wake word: the "Hey Edith" switch (off by default, and only once a model is installed),
// the sensitivity, and the way to the training screen.

import { StyleSheet, Switch, Text, View } from 'react-native';

import type { EventBus } from '../../core/events';
import { localEvent } from '../../core/events';
import { useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { colors, space, useTheme } from '../../core/theme';
import type { WakewordModel, WakewordState } from './model';
import { Slider } from '../../ui/Slider';

const selectEnabled = (s: WakewordState) => s.enabled;
const selectInstalled = (s: WakewordState) => s.installed?.version ?? null;
const selectSensitivity = (s: WakewordState) => s.sensitivity;

export function WakeWordSettings({ model, bus }: { model: WakewordModel; bus: EventBus }) {
  const enabled = useStore(model.store, selectEnabled);
  const installed = useStore(model.store, selectInstalled);
  const sensitivity = useStore(model.store, selectSensitivity);
  const { accent } = useTheme();
  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Text style={styles.label}>“Hey Edith”</Text>
          <Text style={styles.dim}>{installed ? 'Listens for “Hey Edith” while on. Off by default.' : 'Train a model first.'}</Text>
        </View>
        <Switch
          value={enabled}
          disabled={!installed}
          onValueChange={(on) => void model.setEnabled(on)}
          accessibilityLabel="Hey Edith"
          trackColor={{ false: colors.hairline, true: accent }}
          thumbColor={colors.text}
        />
      </View>
      <Text style={styles.label}>Sensitivity</Text>
      <Slider value={sensitivity} onChange={model.setSensitivity} label="Wake word sensitivity" />
      <View style={styles.ends}>
        <Text style={styles.dim}>Fewer false wakes</Text>
        <Text style={styles.dim}>Wakes more easily</Text>
      </View>
      <View style={styles.actions}>
        <Button small icon="account-voice" label="Train wake word" onPress={() => bus.publish(localEvent('app.open', { screen: 'wakeword' }))} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: space.s, marginTop: space.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  flex: { flex: 1 },
  label: { color: colors.text, fontSize: 16 },
  dim: { color: colors.textDim, fontSize: 13 },
  ends: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -space.xs },
  actions: { flexDirection: 'row', marginTop: space.s },
});
