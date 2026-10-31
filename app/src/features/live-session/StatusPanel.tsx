// EDITH's status in the header (plans/ui-next.md §2): a chip on the left with the connection dot,
// the thinking bubble and, while EDITH works, the elapsed time; tapping it drops the status card.
// The chip follows stream events only (status.ts); the card fetches GET /v1/status/details while it
// is open and EDITH is on screen, every 10 s (paused in the background, refreshed at once on return).

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { StatusDetails } from '../../core/api';
import { describeLink, LINK_TONE, type Connection, type ConnectionState } from '../../core/connection';
import { shallowEqual, useStore, type Store } from '../../core/store';
import { clockIST, formatIST } from '../../common/format';
import { colors, legibleText, radius, space, type } from '../../core/theme';
import { Glass } from '../../ui/Glass';
import { GrowSheet, Squish } from '../../ui/motion';
import { ThinkingBubble } from '../../ui/ThinkingBubble';
import type { LiveModel } from './model';
import { barSummary, detailsLabel, formatElapsed, formatTokens, formatUptime, mainRun, pollDetails, turnSince } from './status';

const REFRESH_MS = 10_000;
const BUBBLE = 22;

const AGENT: Record<StatusDetails['agents'][number]['state'], string> = { idle: colors.textDim, busy: colors.accent, blocked: colors.warn };

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
  const run = useStore(model.store, mainRun, shallowEqual);
  const link = useStore(connection.store, selectLink, shallowEqual);
  const isOpen = useStore(open, selectOpen);
  const working = bar.tone !== 'idle';
  // When this turn began on the phone's clock: from the server's elapsed when an event carried it,
  // else the moment work began here (a new turn, or EDITH going busy).
  const startedHere = useMemo(() => Date.now() / 1000, [working, run.ref]);
  const since = useMemo(() => turnSince(run.elapsed, Date.now() / 1000, startedHere), [run.elapsed, startedHere]);

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

/** "0:42", ticking once a second; mounted only while EDITH works. */
function Elapsed({ since, warn }: { since: number; warn: boolean }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return <Text style={[styles.elapsed, warn && styles.warn]}>{formatElapsed(now - since)}</Text>;
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
  const bar = useStore(model.store, barSummary, shallowEqual);
  const link = useStore(connection.store, selectLink, shallowEqual);
  const d = fetched?.details;
  const ago = (t: number | null) => (d && t != null ? formatElapsed(d.ts - t) : null);
  return (
    <Glass level="panel" backdrop={backdrop} radius={radius.l} rim style={styles.card}>
      <ScrollView style={styles.scroll} nestedScrollEnabled>
        {/* From the stream: right even before (or without) the details. */}
        <Section title="Now">
          <Row label="EDITH" value={[bar.label, bar.counts].filter(Boolean).join(' · ')} />
          {bar.tone !== 'idle' && bar.detail ? <Row label="Doing" value={bar.detail} mono /> : null}
          <Row label="Server" value={describeLink(link)} warn={link.link !== 'open'} />
          {link.link === 'unauthorized' ? (
            <CardButton label="Open Settings" onPress={onSettings} />
          ) : link.link === 'offline' || link.link === 'connecting' ? (
            <CardButton label="Retry now" onPress={() => connection.retry()} />
          ) : null}
        </Section>
        {!d ? (
          <Text style={error ? styles.error : styles.cardDim}>{error ? `Couldn't load the details: ${error}` : 'Loading…'}</Text>
        ) : (
          <>
            {error ? <Text style={styles.error}>{`Couldn't refresh: ${error}`}</Text> : null}
            <Section title="EDITH">
              <Row label="State" value={[detailsLabel(d.edith), ago(d.edith.since)].filter(Boolean).join(' · ')} />
              {d.edith.step ? <Row label="Step" value={d.edith.step} mono /> : null}
              {d.edith.ref ? <Row label="Turn" value={`${d.edith.ref}${d.edith.turn_started ? ` · since ${clockIST(d.edith.turn_started)}` : ''}`} /> : null}
              <Row label="tmux" value={d.edith.tmux} warn={d.edith.tmux === 'down'} />
            </Section>
            <Section title="Lanes">
              {d.lanes.side.map((l) => (
                <Row key={l.ref} label="Parallel" value={[l.summary ?? l.ref, l.step, formatElapsed(l.seconds)].filter(Boolean).join(' · ')} />
              ))}
              <Row label="Side lanes" value={`${d.lanes.side.length} of ${d.lanes.max_side}`} />
              <Row label="Queued" value={String(d.lanes.queued)} />
              <Row label="Approvals" value={String(d.lanes.approvals)} warn={d.lanes.approvals > 0} />
            </Section>
            <Section title="Session">
              {d.session ? (
                <>
                  <Row label="Name" value={d.session.title ?? 'Untitled'} />
                  <Row label="Id" value={d.session.id.slice(0, 8)} mono />
                  {d.session.started != null ? <Row label="Started" value={formatIST(d.session.started)} /> : null}
                  {d.session.messages != null ? <Row label="Messages" value={String(d.session.messages)} /> : null}
                  {d.session.context_tokens != null ? <Row label="Context" value={`${formatTokens(d.session.context_tokens)} tokens`} /> : null}
                </>
              ) : (
                <Text style={styles.cardDim}>No conversation yet</Text>
              )}
            </Section>
            <Section title="Agents">
              {d.agents.length ? d.agents.map((a) => <AgentRow key={a.name} agent={a} />) : <Text style={styles.cardDim}>No coding agents running</Text>}
            </Section>
            <Text style={styles.footer}>
              {[d.server.tag ? `Live ${d.server.tag}` : null, `up ${formatUptime(d.server.uptime)}`, `updated ${clockIST(fetched!.at)} IST`].filter(Boolean).join(' · ')}
            </Text>
          </>
        )}
      </ScrollView>
    </Glass>
  );
}

function CardButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Squish onPress={onPress} style={styles.cardButton} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={styles.cardButtonText}>{label}</Text>
    </Squish>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, mono, warn }: { label: string; value: string; mono?: boolean; warn?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, mono && styles.mono, warn && styles.warn]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function AgentRow({ agent: a }: { agent: StatusDetails['agents'][number] }) {
  const state = a.blocked === 'usage_limit' ? 'usage limit' : a.blocked === 'permission' ? 'needs approval' : a.state;
  return (
    <View style={styles.agent} accessibilityLabel={`${a.name}, ${state}${a.branch ? `, on ${a.branch}` : ''}`}>
      <View style={styles.agentHead}>
        <View style={[styles.smallDot, { backgroundColor: a.blocked === 'usage_limit' ? colors.danger : AGENT[a.state] }]} />
        <Text style={styles.agentName} numberOfLines={1}>
          {a.name}
        </Text>
        <Text style={[styles.agentBranch, styles.mono]} numberOfLines={1}>
          {a.branch ?? a.dir}
        </Text>
        <Text style={[styles.agentState, a.state === 'blocked' && styles.warn]}>{state}</Text>
      </View>
      {a.last ? (
        <Text style={styles.agentLast} numberOfLines={2}>
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
  scroll: { maxHeight: 460 },
  error: { color: colors.danger, fontSize: type.size.small, fontWeight: '500', marginBottom: space.s, ...legibleText },
  section: { marginBottom: space.m },
  sectionTitle: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: space.xs, ...legibleText },
  row: { flexDirection: 'row', gap: space.s, paddingVertical: 2 },
  label: { color: colors.textSecondary, fontSize: type.size.small, fontWeight: '500', width: 84, ...legibleText },
  value: { color: colors.text, fontSize: type.size.small, fontWeight: '500', flex: 1, ...legibleText },
  mono: { fontFamily: type.mono },
  warn: { color: colors.warn },
  cardButton: { alignSelf: 'flex-start', marginTop: space.xs, marginLeft: 84 + space.s, paddingHorizontal: space.m, paddingVertical: space.xs, borderRadius: radius.pill, backgroundColor: colors.accentSoft },
  cardButtonText: { color: colors.text, fontSize: type.size.small, fontWeight: '600', ...legibleText },
  agent: { paddingVertical: space.xs },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  smallDot: { width: 8, height: 8, borderRadius: 4 },
  agentName: { color: colors.text, fontSize: type.size.small, fontWeight: '700', flexShrink: 1, ...legibleText },
  agentBranch: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '500', flex: 1, ...legibleText },
  agentState: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '500', ...legibleText },
  agentLast: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '500', marginLeft: 16, marginTop: 2, ...legibleText },
  footer: { color: colors.textSecondary, fontSize: type.size.caption, fontWeight: '500', textAlign: 'center', ...legibleText },
});
