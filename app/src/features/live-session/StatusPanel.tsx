// EDITH's status in the header (plans/ui-next.md §2): a chip on the left with the connection dot,
// the thinking bubble and, while EDITH works, the elapsed time; tapping it drops the status card.
// The chip follows stream events only (status.ts); the card fetches GET /v1/status/details while it
// is open and EDITH is on screen, every 10 s (paused in the background, refreshed at once on return).

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { StatusDetails } from '../../core/api';
import { describeLink, LINK_TONE, type Connection, type ConnectionState } from '../../core/connection';
import { shallowEqual, useStore, type Store } from '../../core/store';
import { colors, legibleText, radius, space, type } from '../../core/theme';
import { Glass } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { GrowSheet, Squish } from '../../ui/motion';
import { ThinkingBubble } from '../../ui/ThinkingBubble';
import type { LiveModel } from './model';
import { ago, barSummary, contextShare, formatElapsed, formatTokens, formatUptime, mainRun, pollDetails, turnSince, type BarSummary } from './status';

const REFRESH_MS = 10_000;
const BUBBLE = 22;

const LABEL_W = 92; // the label column; values line up after it and wrap
const TONE: Record<BarSummary['tone'], string> = { idle: colors.ok, busy: colors.accent, approval: colors.warn };
type Agent = StatusDetails['agents'][number];

type Fetched = { details: StatusDetails; at: number } | null;

const selectLink = (s: ConnectionState) => ({ link: s.link, error: s.error, retryInMs: s.retryInMs });
const selectOpen = (s: boolean) => s;

export interface StatusProps {
  model: LiveModel;
  connection: Connection;
  /** Whether the card is open: the chip and the card share it. */
  open: Store<boolean>;
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
        {working ? <Elapsed since={since} warn={bar.tone === 'approval'} /> : null}
      </Glass>
    </Squish>
  );
});

/**
 * When the running turn began, on the phone's clock: from the server's elapsed when an event carried
 * it, else the moment work began here (a new turn, or EDITH going busy).
 */
function useTurnSince(model: LiveModel, working: boolean): number {
  const run = useStore(model.store, mainRun, shallowEqual);
  const startedHere = useMemo(() => Date.now() / 1000, [working, run.ref]);
  return useMemo(() => turnSince(run.elapsed, Date.now() / 1000, startedHere), [run.elapsed, startedHere]);
}

/** "0:42", ticking once a second; mounted only while EDITH works. */
function Elapsed({ since, warn, big }: { since: number; warn: boolean; big?: boolean }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return <Text style={[big ? styles.bigElapsed : styles.elapsed, warn && styles.warn]}>{formatElapsed(now - since)}</Text>;
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
  const d = fetched?.details;
  return (
    <Glass level="panel" backdrop={backdrop} radius={radius.l} rim style={styles.card}>
      <ScrollView style={styles.scroll} nestedScrollEnabled>
        {/* From the stream: right even before (or without) the details. */}
        <Summary model={model} connection={connection} details={d} onSettings={onSettings} />
        {!d ? (
          <Text style={error ? styles.error : styles.cardDim}>{error ? `Couldn't load the details: ${error}` : 'Loading…'}</Text>
        ) : (
          <>
            {error ? <Text style={styles.error}>{`Couldn't refresh: ${error}`}</Text> : null}
            <Lanes lanes={d.lanes} />
            {d.session ? <Session session={d.session} ts={d.ts} /> : null}
            {d.agents.length ? (
              <Section icon="robot-outline" title="Agents">
                {d.agents.map((a) => (
                  <AgentRow key={a.name} agent={a} />
                ))}
              </Section>
            ) : null}
            <Section icon="server" title="Server">
              <ServerRows connection={connection} />
              {d.server.tag ? <Row label="Version" value={d.server.tag} mono /> : null}
              <Row label="Up" value={formatUptime(d.server.uptime)} />
              <Row label="Claude" value={d.edith.tmux === 'running' ? 'running' : 'down'} warn={d.edith.tmux === 'down'} />
              <Row label="Updated" value={ago(Date.now() / 1000 - fetched!.at)} />
            </Section>
          </>
        )}
      </ScrollView>
    </Glass>
  );
}

/** The top of the card: a dot, the state, what EDITH is doing and the turn's time, larger. */
function Summary({ model, connection, details: d, onSettings }: { model: LiveModel; connection: Connection; details: StatusDetails | undefined; onSettings: () => void }) {
  const bar = useStore(model.store, barSummary, shallowEqual);
  const link = useStore(connection.store, selectLink, shallowEqual);
  const working = bar.tone !== 'idle';
  const since = useTurnSince(model, working);
  const linkUp = link.link === 'open';
  const doing = working ? (bar.detail ?? d?.edith.step ?? null) : null;
  const idleFor = !working && d?.edith.since != null ? `Last active ${ago(d.ts - d.edith.since)}` : null;
  const dot = linkUp ? TONE[bar.tone] : colors[LINK_TONE[link.link]];
  return (
    <View style={styles.summary}>
      <View style={styles.summaryHead}>
        <View style={[styles.stateDot, { backgroundColor: dot }]} />
        <Text style={styles.state} numberOfLines={2}>
          {bar.label}
        </Text>
        {working ? <Elapsed since={since} warn={bar.tone === 'approval'} big /> : null}
      </View>
      {doing ? <Text style={[styles.doing, styles.mono]}>{doing}</Text> : null}
      {bar.counts || idleFor ? <Text style={styles.summaryMeta}>{bar.counts || idleFor}</Text> : null}
      {!linkUp ? <Text style={[styles.summaryMeta, styles.warn]}>{describeLink(link)}</Text> : null}
      {link.link === 'unauthorized' ? (
        <CardButton label="Open Settings" onPress={onSettings} />
      ) : link.link === 'offline' || link.link === 'connecting' ? (
        <CardButton label="Retry now" onPress={() => connection.retry()} />
      ) : null}
    </View>
  );
}

/** The side lanes, the queue and the approvals; only what isn't zero, and nothing when all are. */
function Lanes({ lanes }: { lanes: StatusDetails['lanes'] }) {
  if (!lanes.side.length && !lanes.queued && !lanes.approvals) return null;
  return (
    <Section icon="call-split" title="Lanes">
      {lanes.side.map((l) => (
        <Row key={l.ref} label="Parallel" value={[l.summary ?? l.ref, l.step, formatElapsed(l.seconds)].filter(Boolean).join(' · ')} />
      ))}
      {lanes.side.length ? <Row label="In use" value={`${lanes.side.length} of ${lanes.max_side}`} /> : null}
      {lanes.queued ? <Row label="Queued" value={String(lanes.queued)} /> : null}
      {lanes.approvals ? <Row label="Approvals" value={String(lanes.approvals)} warn /> : null}
    </Section>
  );
}

function Session({ session: s, ts }: { session: NonNullable<StatusDetails['session']>; ts: number }) {
  const share = contextShare(s.context_tokens, s.context_max);
  return (
    <Section icon="message-text-outline" title="Session">
      <Row label="Name" value={s.title || 'Untitled'} />
      {s.started != null ? <Row label="Started" value={ago(ts - s.started)} /> : null}
      {s.messages ? <Row label="Messages" value={String(s.messages)} /> : null}
      {s.context_tokens ? (
        <Row label="Context" value={`${formatTokens(s.context_tokens)} tokens${share != null ? ` of ${formatTokens(s.context_max!)}` : ''}`}>
          {share != null ? (
            <View style={styles.track} accessibilityLabel={`Context ${Math.round(share * 100)}% full`}>
              <View style={[styles.fill, { width: `${share * 100}%` }, share > 0.85 && styles.fillWarn]} />
            </View>
          ) : null}
        </Row>
      ) : null}
      <Row label="Id" value={s.id.slice(0, 8)} mono />
    </Section>
  );
}

/** The link's state as a Server row (from the stream). */
function ServerRows({ connection }: { connection: Connection }) {
  const link = useStore(connection.store, selectLink, shallowEqual);
  return <Row label="Connection" value={describeLink(link)} warn={link.link !== 'open'} />;
}

function CardButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Squish onPress={onPress} style={styles.cardButton} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.cardButtonText}>{label}</Text>
    </Squish>
  );
}

function Section({ icon, title, children }: { icon: string; title: string; children: ReactNode }) {
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

/** Two aligned columns: the label, and the value, which wraps (anything under it goes below it). */
function Row({ label, value, mono, warn, children }: { label: string; value: string; mono?: boolean; warn?: boolean; children?: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.valueCol}>
        <Text style={[styles.value, mono && styles.mono, warn && styles.warn]}>{value}</Text>
        {children}
      </View>
    </View>
  );
}

function agentState(a: Agent): { label: string; chip: object } {
  if (a.blocked === 'usage_limit') return { label: 'usage limit', chip: styles.chipDanger };
  if (a.blocked === 'permission' || a.state === 'blocked') return { label: 'needs approval', chip: styles.chipWarn };
  return a.state === 'busy' ? { label: 'busy', chip: styles.chipBusy } : { label: 'idle', chip: styles.chipIdle };
}

function AgentRow({ agent: a }: { agent: Agent }) {
  const { label, chip } = agentState(a);
  const where = a.branch ? `${a.dir} · ${a.branch}` : a.dir;
  return (
    <View style={styles.agent} accessible accessibilityLabel={`${a.name}, ${label}, in ${where}${a.last ? `. ${a.last}` : ''}`}>
      <View style={styles.agentHead}>
        <Text style={styles.agentName} numberOfLines={1}>
          {a.name}
        </Text>
        <View style={[styles.stateChip, chip]}>
          <Text style={styles.agentState}>{label}</Text>
        </View>
      </View>
      <Text style={[styles.agentBranch, styles.mono]} numberOfLines={1}>
        {where}
      </Text>
      {a.last ? (
        <Text style={styles.agentLast} numberOfLines={3}>
          {a.last}
        </Text>
      ) : null}
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
  cardDim: { color: colors.textSecondary, fontWeight: '500', ...legibleText },
  card: { padding: space.m },
  scroll: { maxHeight: 480 },
  error: { color: colors.danger, fontSize: type.size.small, fontWeight: '500', marginBottom: space.s, ...legibleText },
  summary: { paddingBottom: space.m, marginBottom: space.m, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  stateDot: { width: 10, height: 10, borderRadius: 5 },
  state: { color: colors.text, fontSize: type.size.title, fontWeight: '700', flex: 1, ...legibleText },
  bigElapsed: { color: colors.text, fontSize: type.size.heading, fontWeight: '600', fontVariant: ['tabular-nums'], ...legibleText },
  doing: { color: colors.text, fontSize: type.size.small, fontWeight: '500', marginTop: space.xs, marginLeft: 10 + space.s, ...legibleText },
  summaryMeta: { color: colors.textSecondary, fontSize: type.size.small, fontWeight: '500', marginTop: 2, marginLeft: 10 + space.s, ...legibleText },
  section: { marginBottom: space.m },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: space.xs },
  sectionTitle: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', ...legibleText },
  row: { flexDirection: 'row', gap: space.s, paddingVertical: 3 },
  label: { color: colors.textSecondary, fontSize: type.size.small, fontWeight: '500', width: LABEL_W, ...legibleText },
  valueCol: { flex: 1, minWidth: 0 },
  value: { color: colors.text, fontSize: type.size.small, fontWeight: '500', ...legibleText },
  mono: { fontFamily: type.mono },
  warn: { color: colors.warn },
  track: { height: 3, borderRadius: 1.5, marginTop: 4, backgroundColor: colors.track, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 1.5, backgroundColor: colors.accent },
  fillWarn: { backgroundColor: colors.warn },
  cardButton: { alignSelf: 'flex-start', marginTop: space.s, marginLeft: 10 + space.s, paddingHorizontal: space.m, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
  cardButtonText: { color: colors.text, fontSize: type.size.small, fontWeight: '600', ...legibleText },
  agent: { paddingVertical: space.xs },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  agentName: { color: colors.text, fontSize: type.size.small, fontWeight: '700', flexShrink: 1, ...legibleText },
  stateChip: { paddingHorizontal: 7, paddingVertical: 1, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  chipBusy: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  chipIdle: { borderColor: colors.textFaint },
  chipWarn: { backgroundColor: colors.warnSoft, borderColor: colors.warn },
  chipDanger: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  agentState: { color: colors.text, fontSize: type.size.caption, fontWeight: '600', ...legibleText },
  agentBranch: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '500', marginTop: 2, ...legibleText },
  agentLast: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '500', marginTop: 2, ...legibleText },
});
