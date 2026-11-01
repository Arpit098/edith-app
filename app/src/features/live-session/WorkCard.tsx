// One turn's work as a card (./work): what EDITH ran and edited, in plain language.
// - While the turn runs: the live step ("Running the app tests…") with an elapsed timer, and the
//   last few steps faded under it.
// - When the answer comes: one line, "✓ 7 steps · 2 files changed · 1m 40s" (or a red
//   "· 1 failed"), closed; tap it for the steps. A failure opens it by itself.
// - Steps have an icon per kind and their description (never "Bash $"); tapping one shows the raw
//   command and its result. An edited file is one row per turn (its edits merged): its name, a
//   +N −M chip and its repo-relative path; tapping it opens the diff full screen.
// How much shows is Settings → Chat → Work details (WorkDetailContext).
// The steps are worked out only when the card draws, once per group (memo), and the closed card
// renders no step rows at all, so long chats stay light.

import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type } from '../../core/theme';
import { Icon } from '../../ui/Icon';
import { Counts, DiffScreen, diffLines, Results } from './DiffScreen';
import { STEP_ICON } from './steps';
import { DEFAULT_WORK_DETAIL, duration, summarize, summaryLine, type FileEdit, type Step, type WorkDetail, type WorkGroup } from './work';

export const WorkDetailContext = createContext<WorkDetail>(DEFAULT_WORK_DETAIL);

const RECENT = 3; // steps shown faded under the live one

export interface WorkCardProps {
  group: WorkGroup;
  /** The turn is still running (this is the newest card): the live step and a timer. */
  live: boolean;
  /** The server's clock minus the phone's, in seconds (LiveState.clockOffset): the timer counts from the server's `ts`. */
  clockOffset?: number;
}

export const WorkCard = memo(function WorkCard({ group, live, clockOffset = 0 }: WorkCardProps) {
  const until = group.until;
  const detail = useContext(WorkDetailContext);
  const sum = useMemo(() => summarize(group), [group]);
  const [open, setOpen] = useState<boolean | null>(null); // null: as the detail level and failures say
  const [file, setFile] = useState<FileEdit | null>(null);
  // The answer arrived: back to closed (unless Arpit's setting or a failure keeps it open).
  useEffect(() => {
    if (!live) setOpen(null);
  }, [live]);
  const shown = open ?? (detail === 'full' || (!live && sum.failed > 0));
  const last = group.items[group.items.length - 1]!;
  const seconds = (until ?? last.ts) - group.ts;

  return (
    <View style={[styles.card, sum.failed > 0 && !live && styles.cardFailed]} testID="work-card">
      <Pressable onPress={() => setOpen(!shown)} style={styles.head} accessibilityRole="button" accessibilityState={{ expanded: shown }} accessibilityLabel={live ? `Working: ${liveLabel(sum)}` : `Work: ${summaryLine(sum, seconds)}${sum.failed ? `, ${sum.failed} failed` : ''}`}>
        {live ? <LiveHead label={liveLabel(sum)} since={group.ts} offset={clockOffset} /> : <DoneHead line={summaryLine(sum, seconds)} failed={sum.failed} />}
        <Icon name={shown ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textDim} />
      </Pressable>
      {live && !shown && detail !== 'summary' ? <Recent steps={sum.steps.filter((s) => s !== sum.running).slice(-RECENT)} /> : null}
      {shown ? (
        <View style={styles.body}>
          {sum.entries.map((e) =>
            e.type === 'step' ? (
              <StepRow key={`s${e.step.id}`} step={e.step} full={detail === 'full'} />
            ) : (
              <FileRow key={`f${e.file.path}`} file={e.file} full={detail === 'full'} onOpen={() => setFile(e.file)} />
            ),
          )}
        </View>
      ) : null}
      {file ? <DiffScreen file={file} onClose={() => setFile(null)} /> : null}
    </View>
  );
});

function liveLabel(sum: ReturnType<typeof summarize>): string {
  const step = sum.running ?? sum.steps[sum.steps.length - 1];
  return step ? step.label : 'Working';
}

function LiveHead({ label, since, offset }: { label: string; since: number; offset: number }) {
  const [phoneNow, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    // The timer's one tick a second, only while the turn runs (one live card at most).
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  const now = phoneNow + offset; // the server's clock, as `since` is
  return (
    <>
      <Icon name="progress-clock" size={16} color={colors.warn} />
      <Text style={styles.headText} numberOfLines={1}>
        {label}…
      </Text>
      <Text style={styles.timer}>{duration(now - since)}</Text>
    </>
  );
}

function DoneHead({ line, failed }: { line: string; failed: number }) {
  return (
    <>
      <Icon name={failed ? 'alert-circle-outline' : 'check-circle-outline'} size={16} color={failed ? colors.danger : colors.ok} />
      <Text style={styles.headText} numberOfLines={1}>
        {line}
        {failed ? <Text style={styles.failedText}>{` · ${failed} failed`}</Text> : null}
      </Text>
    </>
  );
}

function Recent({ steps }: { steps: Step[] }) {
  return (
    <View style={styles.recent} testID="work-recent">
      {steps.map((s) => (
        <View key={s.id} style={styles.recentRow}>
          <Icon name={STEP_ICON[s.kind]} size={13} color={colors.textFaint} />
          <Text style={styles.recentText} numberOfLines={1}>
            {s.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const StepRow = memo(function StepRow({ step, full }: { step: Step; full: boolean }) {
  const failed = step.status === 'error';
  // A failed step opens by itself (also one that fails while shown); Full shows every step's
  // command and result (also when switched to Full while shown).
  const [open, setOpen] = useState(failed || full);
  useEffect(() => {
    if (failed || full) setOpen(true);
  }, [failed, full]);
  const tint = failed ? colors.danger : step.status === 'running' ? colors.warn : colors.textDim;
  // The detail sits outside the Pressable: its label would otherwise hide it from TalkBack.
  return (
    <View style={styles.step}>
      <Pressable onPress={() => setOpen((o) => !o)} style={styles.stepRow} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${step.label}${failed ? ', failed' : ''}`} testID={`work-step-${step.id}`}>
        <Icon name={failed ? 'alert-circle-outline' : STEP_ICON[step.kind]} size={15} color={tint} />
        <Text style={[styles.stepText, failed && styles.failedText]} numberOfLines={open ? undefined : 1}>
          {step.label}
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.detail}>
          <Text style={styles.raw} selectable>
            {step.raw}
          </Text>
          {step.result ? (
            <Text style={[styles.result, failed && styles.failedText]} selectable>
              {step.result}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const INLINE_LINES = 24; // Full: this much of a file's diff in the card; the rest in the viewer

const FileRow = memo(function FileRow({ file, full, onOpen }: { file: FileEdit; full: boolean; onOpen: () => void }) {
  const has = file.diffs.length > 0;
  const lines = useMemo(() => (full ? diffLines(file) : []), [full, file]);
  // The inline diff sits outside the Pressable, so TalkBack reads it too.
  return (
    <View style={styles.step}>
      <Pressable onPress={has ? onOpen : undefined} disabled={!has} style={styles.stepRow} accessibilityRole="button" accessibilityLabel={`Edited ${file.name}, ${file.added} lines added, ${file.removed} removed`} accessibilityHint={has ? 'Shows the changes' : undefined} testID={`work-file-${file.name}`}>
        <Icon name="pencil" size={15} color={colors.accent} />
        <View style={styles.fileText}>
          <Text style={styles.stepText} numberOfLines={1}>
            {file.name}
          </Text>
          <Text style={styles.where} numberOfLines={1} ellipsizeMode="head">
            {file.where}
          </Text>
        </View>
        {has ? <Counts added={file.added} removed={file.removed} /> : null}
      </Pressable>
      {lines.length ? (
        // Full: the diff in the card too, lines wrapped (nothing cut off), the headers left out.
        <View style={styles.detail} testID="work-inline-diff">
          {lines.slice(0, INLINE_LINES).map((l) => (
            <Text key={l.key} style={[styles.raw, l.tone === 'add' && styles.add, l.tone === 'del' && styles.del, l.tone === 'hunk' && styles.hunk]}>
              {l.text || ' '}
            </Text>
          ))}
          {lines.length > INLINE_LINES ? <Text style={styles.more}>{`${lines.length - INLINE_LINES} more lines: tap the file to see all`}</Text> : null}
          {lines.length <= INLINE_LINES && file.results.length ? <Results results={file.results} /> : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.m, marginVertical: space.xs, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  cardFailed: { borderColor: colors.dangerSoft },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m, paddingVertical: space.s + 2, minHeight: 44 },
  headText: { flex: 1, color: colors.text, fontSize: type.size.small },
  timer: { color: colors.textDim, fontSize: type.size.caption, fontVariant: ['tabular-nums'] },
  failedText: { color: colors.danger },
  recent: { paddingHorizontal: space.m, paddingBottom: space.s, gap: 2 },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: space.s, opacity: 0.8 },
  recentText: { flex: 1, color: colors.textFaint, fontSize: type.size.caption },
  body: { paddingHorizontal: space.s, paddingBottom: space.s, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  step: { paddingHorizontal: space.s, paddingVertical: space.xs + 2 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  stepText: { flex: 1, color: colors.text, fontSize: type.size.small },
  fileText: { flex: 1 },
  where: { color: colors.textFaint, fontSize: type.size.caption },
  detail: { marginTop: space.xs, marginLeft: 23, padding: space.s, borderRadius: radius.s, backgroundColor: colors.code, gap: space.xs },
  raw: { color: colors.textDim, fontFamily: type.mono, fontSize: 12 },
  result: { color: colors.text, fontFamily: type.mono, fontSize: 12 },
  add: { color: colors.diffAddText, backgroundColor: colors.diffAdd },
  del: { color: colors.diffDelText, backgroundColor: colors.diffDel },
  hunk: { color: colors.textFaint },
  more: { color: colors.textDim, fontSize: type.size.caption, marginTop: space.xs },
});
