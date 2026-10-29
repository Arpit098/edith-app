// The composer while EDITH listens: a timer against the cap, a level meter, Stop and Cancel.
// Driven by the recorder's ~10 progress events a second; nothing polls.

import { memo } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { colors, radius, space } from '../../ui/theme';
import { MAX_RECORDING_MS, type VoiceModel, type VoiceState } from './voice';

const selectPhase = (s: VoiceState) => s.phase;
const selectElapsed = (s: VoiceState) => Math.floor(s.elapsedMs / 1000);
const selectLevel = (s: VoiceState) => Math.round(s.level * 20) / 20; // 5% steps: fewer re-renders

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** Shown in place of the text box while recording, transcribing or sending. */
export const VoiceBar = memo(function VoiceBar({ voice, onStop }: { voice: VoiceModel; onStop: () => void }) {
  const phase = useStore(voice.store, selectPhase);
  const seconds = useStore(voice.store, selectElapsed);
  const level = useStore(voice.store, selectLevel);
  if (phase === 'transcribing' || phase === 'sending') {
    return (
      <View style={styles.bar}>
        <ActivityIndicator color={colors.accent} />
        <Text style={styles.label}>{phase === 'sending' ? 'Sending…' : 'Transcribing on edith…'}</Text>
      </View>
    );
  }
  const left = MAX_RECORDING_MS / 1000 - seconds;
  return (
    <View style={styles.bar} accessibilityLiveRegion="polite">
      <View style={[styles.dot, seconds % 2 === 1 && styles.dotDim]} />
      <Text style={styles.time} accessibilityLabel={`Recording, ${seconds} seconds`}>
        {clock(seconds)}
      </Text>
      <View style={styles.meter}>
        <View style={[styles.meterFill, { width: `${Math.max(4, level * 100)}%` }]} />
      </View>
      {left <= 10 ? <Text style={styles.warn}>{left}s left</Text> : null}
      <Button small icon="close" variant="ghost" onPress={() => void voice.cancel()} accessibilityLabel="Cancel recording" />
      <Button small icon="stop" label="Stop" variant="primary" onPress={onStop} accessibilityLabel="Stop and transcribe" />
    </View>
  );
});

const styles = StyleSheet.create({
  bar: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.s, minHeight: 44, paddingHorizontal: space.s, backgroundColor: colors.surface, borderRadius: radius.m },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.danger },
  dotDim: { opacity: 0.35 },
  time: { color: colors.text, fontVariant: ['tabular-nums'], fontSize: 15, minWidth: 40 },
  meter: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.border, overflow: 'hidden' },
  meterFill: { height: 6, borderRadius: 3, backgroundColor: colors.accent },
  warn: { color: colors.warn, fontSize: 12 },
  label: { color: colors.textDim, fontSize: 14 },
});
