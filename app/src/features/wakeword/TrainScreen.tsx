// Train wake word: one step at a time (near, across the room, whispered, home noise), each take
// checked on the phone, kept takes uploaded as they come, and the model's status on edith.

import { memo, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatIST } from '../../common/format';
import { shallowEqual, useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { colors, radius, space, useChrome } from '../../core/theme';
import type { TrainClip, WakewordModel, WakewordState } from './model';
import { STEPS, stepOf, type ClipKind, type Step } from './plan';

const selectClips = (s: WakewordState) => s.clips;
const selectRecording = (s: WakewordState) => s.recording;
const selectLast = (s: WakewordState) => s.last;
const selectError = (s: WakewordState) => s.error;
const selectPanel = (s: WakewordState) => ({ server: s.server, status: s.status, installed: s.installed, uploading: s.uploading, loaded: s.loaded });

const countOf = (clips: TrainClip[], kind: ClipKind) => clips.filter((c) => c.kind === kind).length;

export function TrainScreen({ model }: { model: WakewordModel }) {
  const clips = useStore(model.store, selectClips);
  const recording = useStore(model.store, selectRecording);
  const last = useStore(model.store, selectLast);
  const error = useStore(model.store, selectError);
  const firstOpen = STEPS.find((s) => countOf(clips, s.kind) < s.target)?.kind ?? STEPS[0]!.kind;
  const [open, setOpen] = useState<ClipKind | null>(null);
  const current = recording?.kind ?? open ?? firstOpen;
  useEffect(() => void model.refreshStatus(), [model]);
  const failed = clips.filter((c) => c.status === 'failed');
  const chromeInsets = useChrome(); // the floating header and tab bar

  return (
    <ScrollView contentContainerStyle={[styles.body, { paddingTop: chromeInsets.top + space.m, paddingBottom: chromeInsets.bottom + space.l }]}>
      <StatusPanel model={model} clips={clips} />
      {STEPS.map((step) => (
        <StepCard key={step.kind} step={step} count={countOf(clips, step.kind)} expanded={step.kind === current} onOpen={() => !recording && setOpen(step.kind)}>
          {step.kind === current ? <Recorder model={model} step={step} /> : null}
        </StepCard>
      ))}
      {last ? (
        <View style={[styles.card, styles.row]} accessibilityLiveRegion="polite">
          <Icon name={last.kept ? 'check-circle-outline' : 'alert-circle-outline'} size={20} color={last.kept ? colors.ok : colors.warn} />
          <View style={styles.flex}>
            <Text style={styles.text}>{last.kept ? `Kept: ${stepOf(last.kind).title.toLowerCase()} take` : 'Not kept. Please try again:'}</Text>
            {last.kept ? null : last.problems.map((p) => <Text key={p} style={styles.dim}>{p}</Text>)}
          </View>
          {last.kept ? <Button small label="Redo" icon="undo" onPress={() => void model.remove(last.sha256)} /> : null}
        </View>
      ) : null}
      {failed.map((c) => (
        <View key={c.sha256} style={[styles.card, styles.row]}>
          <Icon name="cloud-alert" size={20} color={colors.danger} />
          <Text style={[styles.dim, styles.flex]}>
            {stepOf(c.kind).title} clip not uploaded: {c.error}
          </Text>
          <Button small label="Retry" onPress={() => model.retry(c.sha256)} />
          <Button small icon="delete-outline" variant="ghost" accessibilityLabel="Delete clip" onPress={() => void model.remove(c.sha256)} />
        </View>
      ))}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <DeleteAll model={model} />
    </ScrollView>
  );
}

const StatusPanel = memo(function StatusPanel({ model, clips }: { model: WakewordModel; clips: TrainClip[] }) {
  const { server, status, installed, uploading } = useStore(model.store, selectPanel, shallowEqual);
  const wanted = STEPS.reduce((n, s) => n + s.target, 0);
  const uploaded = clips.filter((c) => c.status === 'uploaded').length;
  const done = STEPS.every((s) => countOf(clips, s.kind) >= s.target);
  const m = status?.model;
  let line: string;
  if (server === 'needs_update') line = 'edith needs a server update before it can take wake word recordings. Your clips wait on the phone.';
  else if (!done) line = 'Record every step; clips upload as you go.';
  else if (uploaded < clips.length) line = 'Uploading the last clips…';
  else if (status?.state === 'trained') line = 'Trained on these recordings.';
  else line = 'Waiting for training on the Mac.';
  const pct = (v: number | null) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Status</Text>
      <Text style={styles.text}>
        {clips.length} of {wanted} clips recorded · {uploaded} uploaded
      </Text>
      {uploading && uploading.total > 0 ? <Bar value={uploading.sent / uploading.total} /> : null}
      <Text style={[styles.dim, server === 'needs_update' && styles.warn]}>{line}</Text>
      {m ? (
        <View style={styles.model}>
          <Text style={styles.text}>Model on edith: {m.version}</Text>
          <Text style={styles.dim}>
            Trained {formatIST(m.createdAt)} · misses {pct(m.falseRejectRate)} · false wakes {m.falseAcceptsPerHour ?? '–'}/h
            {m.noiseFalseAcceptsPerHour != null ? ` (${m.noiseFalseAcceptsPerHour}/h on your noise)` : ''}
          </Text>
          <Text style={styles.dim}>
            {installed?.version === m.version ? 'Installed on this phone.' : installed ? `This phone has ${installed.version}; the new one comes with the next app update.` : 'It reaches this phone with the next app update.'}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

/** Deletes every recording session on edith and every take on the phone, after a confirm. */
function DeleteAll({ model }: { model: WakewordModel }) {
  const [busy, setBusy] = useState(false);
  const confirm = () =>
    Alert.alert('Delete all recordings?', 'This deletes every wake word recording on edith and the takes waiting on this phone. A trained model stays.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete all',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          void model.deleteAll().finally(() => setBusy(false));
        },
      },
    ]);
  return (
    <View style={styles.row}>
      <Button small variant="danger" icon="delete-forever-outline" label="Delete all recordings" busy={busy} onPress={confirm} />
    </View>
  );
}

function StepCard({ step, count, expanded, onOpen, children }: { step: Step; count: number; expanded: boolean; onOpen: () => void; children?: React.ReactNode }) {
  const complete = count >= step.target;
  return (
    <View style={[styles.card, expanded && styles.cardOpen]}>
      <View style={styles.row}>
        <Icon name={complete ? 'check-circle' : 'circle-outline'} size={20} color={complete ? colors.ok : colors.textDim} />
        <Text style={[styles.title, styles.flex]} onPress={onOpen} accessibilityRole="button">
          {step.title}
        </Text>
        <Text style={styles.dim}>
          {count} / {step.target}
        </Text>
      </View>
      <Bar value={Math.min(1, count / step.target)} />
      {children}
    </View>
  );
}

const selectLevel = (s: WakewordState) => s.recording;

function Recorder({ model, step }: { model: WakewordModel; step: Step }) {
  const r = useStore(model.store, selectLevel);
  const mine = r?.kind === step.kind ? r : null;
  return (
    <View style={styles.recorder}>
      <Text style={styles.text}>{step.prompt}</Text>
      {mine?.phase === 'waiting' ? (
        <View style={styles.row}>
          <Countdown until={mine.startsAt} />
          <Button small label="Cancel" onPress={() => void model.cancel()} />
        </View>
      ) : mine ? (
        <View style={styles.gap}>
          <Bar value={mine.level} tone="accent" />
          <View style={styles.row}>
            <Text style={[styles.dim, styles.flex]}>
              Recording {(mine.elapsedMs / 1000).toFixed(1)} s of {step.maxMs / 1000} s
            </Text>
            <Button label="Stop" icon="stop" variant="danger" onPress={() => void model.stop()} />
          </View>
        </View>
      ) : (
        <View style={styles.row}>
          <Button label="Record" icon="microphone" variant="primary" onPress={() => void model.record(step.kind)} />
        </View>
      )}
    </View>
  );
}

const secondsLeft = (until: number) => Math.max(0, Math.ceil((until - Date.now()) / 1000));

/** 5, 4, 3, 2, 1: one timer per second, only while a delayed take waits (it stops at 0). */
function Countdown({ until }: { until: number }) {
  const [seconds, setSeconds] = useState(() => secondsLeft(until));
  useEffect(() => {
    if (seconds <= 0) return;
    // Wake exactly when the shown number should drop, then re-render with the new one.
    const t = setTimeout(() => setSeconds(secondsLeft(until)), until - Date.now() - (seconds - 1) * 1000);
    return () => clearTimeout(t);
  }, [seconds, until]);
  return (
    <View style={[styles.row, styles.flex]} accessibilityLiveRegion="polite">
      <Text style={styles.count}>{seconds || '•'}</Text>
      <Text style={[styles.dim, styles.flex]}>{seconds ? 'Get in place: recording starts soon.' : 'Starting…'}</Text>
    </View>
  );
}

function Bar({ value, tone = 'ok' }: { value: number; tone?: 'ok' | 'accent' }) {
  return (
    <View style={styles.track}>
      <View style={[styles.fill, { width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, backgroundColor: tone === 'ok' ? colors.ok : colors.accent }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.m, gap: space.m },
  card: { backgroundColor: colors.card, borderRadius: radius.m, padding: space.m, gap: space.s },
  cardOpen: { borderWidth: 1, borderColor: colors.accent },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  flex: { flex: 1 },
  gap: { gap: space.s },
  heading: { color: colors.textDim, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  text: { color: colors.text, fontSize: 15 },
  dim: { color: colors.textDim, fontSize: 13 },
  warn: { color: colors.warn },
  count: { color: colors.accent, fontSize: 28, fontWeight: '700', minWidth: 28, textAlign: 'center' },
  error: { color: colors.danger, fontSize: 14 },
  model: { gap: space.xs, marginTop: space.xs },
  recorder: { gap: space.m, marginTop: space.xs },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.hairline, overflow: 'hidden' },
  fill: { height: 4 },
});
