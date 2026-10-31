// EDITH's status in the header (plans/ui-next.md §2): a chip on the left with the connection dot,
// the thinking bubble and, while EDITH works, the elapsed time; tapping it drops the status card.
// The chip follows stream events only (status.ts); the card fetches GET /v1/status/details while it
// is open and EDITH is on screen, every 10 s (paused in the background, refreshed at once on return).
//
// The card (Arpit, 31 Oct: "needs a little improvement for showing the details") reads top-down: a
// summary (a state dot, what EDITH is doing, the turn's time in large type), then Lanes, Session,
// Agents and Server, each with an icon, in aligned label/value rows that wrap rather than cut off.
// Rows with nothing to say (zero queued, no approvals) are left out.

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import type { StatusDetails } from '../../core/api';
import { describeLink, LINK_TONE, type Connection, type ConnectionState } from '../../core/connection';
import { shallowEqual, useStore, type Store } from '../../core/store';
import { clockIST } from '../../common/format';
import { colors, legibleText, radius, space, type } from '../../core/theme';
import { Glass } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { GrowSheet, Squish } from '../../ui/motion';
import { ThinkingBubble } from '../../ui/ThinkingBubble';
import type { LiveModel } from './model';
import { agentChip, barSummary, contextUsage, formatAgo, formatElapsed, formatUptime, mainRun, pollDetails, turnSince, type AgentTone, type BarSummary } from './status';

const REFRESH_MS = 10_000;
const BUBBLE = 22;
const LABEL_WIDTH = 88;

const TONE: Record<BarSummary['tone'], string> = { idle: colors.textDim, busy: colors.accent, approval: colors.warn };
const CHIP: Record<AgentTone, { bg: string; dot: string }> = {
  busy: { bg: colors.accentSoft, dot: colors.accent },
  idle: { bg: colors.card, dot: colors.textDim },
  warn: { bg: colors.warnSoft, dot: colors.warn },
  danger: { bg: colors.dangerSoft, dot: colors.danger },
};

type Fetched = { details: StatusDetails; at: number } | null;

const selectLink = (s: ConnectionState) => ({ link: s.link, error: s.error, retryInMs: s.retryInMs });
const selectOpen = (s: boolean) => s;

export interface StatusProps {
  model: LiveModel;
  connection: Connection;
  /** Whether the card is open: the chip and the card share it. */
  open: Store<boolean>;
}

/** When the running turn began, on the phone's clock (see turnSince). */
function useTurnSince(model: LiveModel, working: boolean): number {
  const run = useStore(model.store, mainRun, shallowEqual);
  // The moment work began here (a new turn, or EDITH going busy): the fallback before any event
  // has carried the server's elapsed time.
  const startedHere = useMemo(() => Date.now() / 1000, [working, run.ref]);
  return useMemo(() => turnSince(run.elapsed, Date.now() / 1000, startedHere), [run.elapsed, startedHere]);
}

/** The header chip: `● bubble 0:42`. The bubble moves only while EDITH thinks or runs a tool. */
export const StatusChip = memo(function StatusChip({ model, connection, open, backdrop }: StatusProps & { backdrop?: number | null }) {
  const bar = useStore(model.store, barSummary, shallowEqual);
  const link = useStore(connection.store, selectLink, shallowEqual);
  const isOpen = useStore(open, selectOpen);
  const working = bar.tone !== 'idle';
  const since = useTurnSince(model, working);

  const label = `${describeLink(link)}. EDITH: ${bar.label}${bar.counts ? `, ${bar.counts}` : ''}. ${isOpen ? 'Hide' : 'Show'} details`;
  return (
    <Squish
      onPress={() => open.set((o) => !o)}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityState={{ expanded: isOpen }}
      accessibilityLabel={label}
    >
      <Glass level="thin" backdrop={backdrop} radius={radius.pill} style={styles.chip}>
        <View style={[styles.dot, { backgroundColor: colors[LINK_TONE[link.link]] }]} />
        <ThinkingBubble active={bar.tone === 'busy'} size={BUBBLE} />
        {working ? <Elapsed since={since} style={[styles.elapsed, bar.tone === 'approval' && styles.warn]} /> : null}
      </Glass>
    </Squish>
  );
});

/** "0:42", ticking once a second; mounted only while EDITH works. */
function Elapsed({ since, style }: { since: number; style: StyleProp<TextStyle> }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return <Text style={style}>{formatElapsed(now - since)}</Text>;
}

/**
 * The status card, dropped from the chip (the shell draws it over the screen, `top` under the
 * header). It grows out of the chip's corner; a tap outside or Android's back closes it.
 */
export function StatusPopup({ model, connection, open, top, backdrop, onSettings }: StatusProps & { top: number; backdrop: number | null; onSettings: () => void }) {
  const isOpen = useStore(open, selectOpen);
  const [fetched, setFetched] = useState<Fetched>(null);
  const [error, setError] = useState<string | null>(null);
  const visible = useVisible(model);

  useEffect(() => {
    if (!isOpen || !visible) return;
    return pollDetails(
      () => model.details(),
      (r) => {
        if ('error' in r) return setError(r.error);
        setError(null);
        setFetched(r);
      },
      REFRESH_MS,
    );
  }, [isOpen, visible, model]);

  // Back closes the card first (handlers run newest first).
  useEffect(() => {
    if (!isOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      open.set(false);
      return true;
    });
    return () => sub.remove();
  }, [isOpen, open]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {isOpen ? <Pressable style={StyleSheet.absoluteFill} onPress={() => open.set(false)} accessibilityLabel="Close the status" importantForAccessibility="no" /> : null}
      <GrowSheet open={isOpen} origin="left top" style={[styles.popup, { top: top + space.xs }]}>
        <Card model={model} connection={connection} fetched={fetched} error={error} backdrop={backdrop} onSettings={onSettings} />
      </GrowSheet>
    </View>
  );
}

/** Whether EDITH is on screen; true where the app has no visibility port. */
function useVisible(model: LiveModel): boolean {
  const v = model.visibility;
  const [visible, setVisible] = useState(() => v?.active() ?? true);
  useEffect(() => {
    if (!v) return;
    setVisible(v.active()); // it may have changed between the first render and subscribing
    return v.onChange(setVisible);
  }, [v]);
  return visible;
}

interface CardProps {
  model: LiveModel;
  connection: Connection;
  fetched: Fetched;
  error: string | null;
  backdrop: number | null;
  onSettings: () => void;
}

function Card({ model, connection, fetched, error, backdrop, onSettings }: CardProps) {
  const link = useStore(connection.store, selectLink, shallowEqual);
  const d = fetched?.details;
  return (
    <Glass level="panel" backdrop={backdrop} radius={radius.l} rim style={styles.card}>
      <ScrollView style={styles.scroll} nestedScrollEnabled>
        <Summary model={model} fetched={fetched} />
        {link.link !== 'open' ? (
          <View style={styles.linkWarn}>
            <Text style={[styles.value, styles.warn]}>{describeLink(link)}</Text>
            {link.link === 'unauthorized' ? (
              <CardButton label="Open Settings" onPress={onSettings} />
            ) : link.link === 'offline' || link.link === 'connecting' ? (
              <CardButton label="Retry now" onPress={() => connection.retry()} />
            ) : null}
          </View>
        ) : null}
        {error ? <Text style={styles.error}>{d ? `Couldn't refresh: ${error}` : `Couldn't load the details: ${error}`}</Text> : null}
        {!d ? (
          error ? null : <Text style={styles.cardDim}>Loading…</Text>
        ) : (
          <>
            <Lanes lanes={d.lanes} />
            <Session session={d.session} ts={d.ts} />
            <Section title="Agents" icon="robot-outline">
              {d.agents.length ? d.agents.map((a) => <AgentRow key={a.name} agent={a} />) : <Text style={styles.cardDim}>No coding agents running</Text>}
            </Section>
            <Section title="Server" icon="server-outline">
              <Row label="Link" value={describeLink(link)} warn={link.link !== 'open'} />
              {d.server.tag ? <Row label="Version" value={d.server.tag} mono /> : null}
              <Row label="Up for" value={formatUptime(d.server.uptime)} />
              <Row label="Claude" value={d.edith.tmux === 'down' ? 'tmux is down' : 'running'} warn={d.edith.tmux === 'down'} />
              <Row label="Checked" value={`${clockIST(fetched!.at)} IST`} />
            </Section>
          </>
        )}
      </ScrollView>
    </Glass>
  );
}

/**
 * The top of the card: a state dot, what EDITH is doing (from the stream, so it's right before the
 * details arrive), the step or prompt under it, and the turn's time in large type while it works.
 */
function Summary({ model, fetched }: { model: LiveModel; fetched: Fetched }) {
  const bar = useStore(model.store, barSummary, shallowEqual);
  const working = bar.tone !== 'idle';
  const local = useTurnSince(model, working);
  const e = fetched?.details.edith;
  // The server's turn start, moved onto the phone's clock (its `ts` against when it arrived here).
  const since = e?.ref && e.turn_started != null ? e.turn_started + (fetched!.at - fetched!.details.ts) : local;
  const idleFor = !working && e?.since != null ? `for ${formatUptime(fetched!.details.ts - e.since)}` : null;
  return (
    <View style={styles.summary} accessibilityLabel={`EDITH: ${bar.label}${bar.counts ? `, ${bar.counts}` : ''}`}>
      <View style={[styles.stateDot, { backgroundColor: TONE[bar.tone] }]} />
      <View style={styles.summaryText}>
        <Text style={[styles.summaryTitle, bar.tone === 'approval' && styles.warn]}>{bar.label}</Text>
        {working && bar.detail ? <Text style={[styles.summaryDetail, styles.mono]}>{bar.detail}</Text> : null}
        {[bar.counts, idleFor].filter(Boolean).length ? <Text style={styles.summaryDetail}>{[bar.counts, idleFor].filter(Boolean).join(' · ')}</Text> : null}
      </View>
      {working ? <Elapsed since={since} style={[styles.summaryTime, bar.tone === 'approval' && styles.warn]} /> : null}
    </View>
  );
}

function Lanes({ lanes }: { lanes: StatusDetails['lanes'] }) {
  const rows = [
    ...lanes.side.map((l) => <Row key={l.ref} label="Parallel" value={[l.summary ?? l.ref, l.step, formatElapsed(l.seconds)].filter(Boolean).join(' · ')} />),
    lanes.side.length ? <Row key="side" label="Side lanes" value={`${lanes.side.length} of ${lanes.max_side} running`} /> : null,
    lanes.queued ? <Row key="queued" label="Queued" value={lanes.queued === 1 ? '1 message' : `${lanes.queued} messages`} /> : null,
    lanes.approvals ? <Row key="approvals" label="Approvals" value={`${lanes.approvals} waiting`} warn /> : null,
  ].filter(Boolean);
  return (
    <Section title="Lanes" icon="source-fork">
      {rows.length ? rows : <Text style={styles.cardDim}>Only the main lane, nothing waiting</Text>}
    </Section>
  );
}

function Session({ session: s, ts }: { session: StatusDetails['session']; ts: number }) {
  const context = s?.context_tokens != null ? contextUsage(s.context_tokens) : null;
  return (
    <Section title="Session" icon="message-text-outline">
      {s ? (
        <>
          <Row label="Name" value={s.title ?? 'Untitled'} />
          {s.started != null ? <Row label="Started" value={formatAgo(ts - s.started)} /> : null}
          {s.messages ? <Row label="Messages" value={String(s.messages)} /> : null}
          {context ? (
            <Row label="Context" value={context.text}>
              {context.fraction != null ? (
                <View style={styles.track} accessibilityLabel={`Context ${Math.round(context.fraction * 100)}% full`}>
                  <View style={[styles.fill, { width: `${Math.min(100, Math.max(2, context.fraction * 100))}%` }, context.fraction > 0.8 && styles.fillWarn]} />
                </View>
              ) : null}
            </Row>
          ) : null}
          <Row label="Id" value={s.id.slice(0, 8)} mono />
        </>
      ) : (
        <Text style={styles.cardDim}>No conversation yet</Text>
      )}
    </Section>
  );
}

function CardButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Squish onPress={onPress} style={styles.cardButton} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.cardButtonText}>{label}</Text>
    </Squish>
  );
}

function Section({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Icon name={icon} size={14} color={colors.textSecondary} halo />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

/** A label/value row: the labels line up in one column; long values wrap under themselves. */
function Row({ label, value, mono, warn, children }: { label: string; value: string; mono?: boolean; warn?: boolean; children?: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.valueBox}>
        <Text style={[styles.value, mono && styles.mono, warn && styles.warn]}>{value}</Text>
        {children}
      </View>
    </View>
  );
}

function AgentRow({ agent: a }: { agent: StatusDetails['agents'][number] }) {
  const chip = agentChip(a);
  const where = a.branch ?? a.dir;
  return (
    <View style={styles.agent} accessibilityLabel={`${a.name}, ${chip.label}${a.branch ? `, on ${a.branch}` : ''}${a.last ? `. ${a.last}` : ''}`}>
      <View style={styles.agentHead}>
        <Text style={styles.agentName}>{a.name}</Text>
        <View style={[styles.agentChip, { backgroundColor: CHIP[chip.tone].bg }]}>
          <View style={[styles.smallDot, { backgroundColor: CHIP[chip.tone].dot }]} />
          <Text style={styles.agentState}>{chip.label}</Text>
        </View>
      </View>
      {where ? <Text style={[styles.agentBranch, styles.mono]}>{where}</Text> : null}
      {a.last ? <Text style={styles.agentLast}>{a.last}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.s, height: 34, paddingHorizontal: space.m },
  dot: { width: 8, height: 8, borderRadius: 4 },
  elapsed: { color: colors.text, fontSize: type.size.small, fontVariant: ['tabular-nums'], minWidth: 30 },
  popup: { position: 'absolute', left: space.m, right: space.m, maxWidth: 420 },
  // The card is clear glass with no pane behind its text: every line carries the dark halo
  // (legibleText) and a slightly heavier weight (core/theme/__tests__/contrast.test.ts).
  cardDim: { color: colors.textSecondary, fontSize: type.size.small, fontWeight: '500', ...legibleText },
  card: { padding: space.m },
  scroll: { maxHeight: 520 },
  summary: { flexDirection: 'row', alignItems: 'flex-start', gap: space.s, paddingBottom: space.m, marginBottom: space.m, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  stateDot: { width: 10, height: 10, borderRadius: 5, marginTop: 7 },
  summaryText: { flex: 1, gap: 2 },
  summaryTitle: { color: colors.text, fontSize: type.size.title, fontWeight: '700', ...legibleText },
  summaryDetail: { color: colors.textSecondary, fontSize: type.size.small, fontWeight: '500', ...legibleText },
  summaryTime: { color: colors.text, fontSize: type.size.heading, fontWeight: '600', fontVariant: ['tabular-nums'], ...legibleText },
  linkWarn: { marginBottom: space.m, gap: space.xs },
  error: { color: colors.danger, fontSize: type.size.small, fontWeight: '500', marginBottom: space.s, ...legibleText },
  section: { marginBottom: space.m },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs, marginBottom: space.xs },
  sectionTitle: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', ...legibleText },
  row: { flexDirection: 'row', gap: space.s, paddingVertical: 3 },
  label: { color: colors.textSecondary, fontSize: type.size.small, fontWeight: '500', width: LABEL_WIDTH, ...legibleText },
  valueBox: { flex: 1, gap: space.xs },
  value: { color: colors.text, fontSize: type.size.small, fontWeight: '500', ...legibleText },
  mono: { fontFamily: type.mono },
  warn: { color: colors.warn },
  track: { height: 3, borderRadius: 1.5, backgroundColor: colors.hairline, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 1.5, backgroundColor: colors.accent },
  fillWarn: { backgroundColor: colors.warn },
  cardButton: { alignSelf: 'flex-start', paddingHorizontal: space.m, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
  cardButtonText: { color: colors.text, fontSize: type.size.small, fontWeight: '600', ...legibleText },
  agent: { paddingVertical: space.xs, gap: 2 },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: space.s, flexWrap: 'wrap' },
  agentChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.s, paddingVertical: 1, borderRadius: radius.pill },
  smallDot: { width: 6, height: 6, borderRadius: 3 },
  agentName: { color: colors.text, fontSize: type.size.small, fontWeight: '700', flexShrink: 1, ...legibleText },
  agentBranch: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '500', ...legibleText },
  agentState: { color: colors.text, fontSize: type.size.caption, fontWeight: '600', ...legibleText },
  agentLast: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '500', ...legibleText },
});
