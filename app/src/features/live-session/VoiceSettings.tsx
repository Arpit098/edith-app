// Settings → Voice input: send right after speaking, or put the words in the box to edit (default).

import { StyleSheet, Switch, Text, View } from 'react-native';

import { useStore } from '../../core/store';
import { colors, space } from '../../core/theme';
import type { VoiceModel, VoiceState } from './voice';

const selectAutoSend = (s: VoiceState) => s.autoSend;
const selectAvailable = (s: VoiceState) => s.available;

export function VoiceSettings({ voice }: { voice: VoiceModel }) {
  const autoSend = useStore(voice.store, selectAutoSend);
  const available = useStore(voice.store, selectAvailable);
  if (!available) return <Text style={styles.dim}>The microphone isn't available in this build.</Text>;
  return (
    <View style={styles.row}>
      <View style={styles.text}>
        <Text style={styles.label}>Send right after speaking</Text>
        <Text style={styles.dim}>{autoSend ? 'The mic sends what you said straight away.' : 'What you said goes into the box first, so you can edit it.'}</Text>
      </View>
      <Switch
        value={autoSend}
        onValueChange={(on) => void voice.setAutoSend(on)}
        trackColor={{ false: colors.hairline, true: colors.accent }}
        thumbColor={colors.text}
        accessibilityLabel="Send right after speaking"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  text: { flex: 1, gap: 2 },
  label: { color: colors.text, fontSize: 15 },
  dim: { color: colors.textDim, fontSize: 13 },
});
