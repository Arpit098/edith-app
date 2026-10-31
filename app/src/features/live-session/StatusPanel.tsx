// The status bar under the Live header and the card it drops down. The bar follows stream events
// only (status.ts barSummary); the card fetches GET /v1/status/details while it is open and EDITH is
// on screen, every 10 s (paused in the background, refreshed at once on return).

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { StatusDetails } from '../../core/api';
import { shallowEqual, useStore } from '../../core/store';
import { clockIST, formatIST } from '../../common/format';
import { colors, radius, space, type } from '../../core/theme';
import { Glass } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import type { LiveModel } from './model';
import { barSummary, detailsLabel, formatElapsed, formatTokens, formatUptime, pollDetails, sinceFrom, type BarSummary } from './status';

const REFRESH_MS = 10_000;

const TONE: Record<BarSummary['tone'], string> = { idle: colors.ok, busy: colors.accent, approval: colors.warn };
const AGENT: Record<StatusDetails['agents'][number]['state'], string> = { idle: colors.textDim, busy: colors.accent, blocked: colors.warn };

type Fetched = { details: StatusDetails; at: number } | null;

/** `backdrop`: the view the pill and card float over (useBackdrop), for real glass; flat without it. */
export const StatusPanel = memo(function StatusPanel({ model, backdrop }: { model: LiveModel; backdrop?: number | null }) {
  const bar = useStore(model.store, barSummary, shallowEqual);
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<Fetched>(null);
  const [error, setError] = useState<string | null>(null);
  const changedAt = useMemo(() => Date.now() / 1000, [bar.state]); // when the bar's state last changed here
  const since = sinceFrom(bar.state, changedAt, fetched?.details ?? null, fetched?.at ?? 0);

  const visible = useVisible(model);

  useEffect(() => {
    if (!open || !visible) return;
    return pollDetails(
      () => model.details(),
      (r) => {
        if ('error' in r) return setError(r.error);
        setError(null);
        setFetched(r);
      },
      REFRESH_MS,
    );
  }, [open, visible, model]);

  return (
    <View>
      <Glass level="thin" backdrop={backdrop} radius={radius.pill}>
        <Pressable
          style={styles.bar}
          onPress={() => setOpen((o) => !o)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${bar.label}${bar.counts ? `, ${bar.counts}` : ''}. ${open ? 'Hide' : 'Show'} details`}
        >
          <View style={[styles.dot, { backgroundColor: TONE[bar.tone] }]} />
          <Text style={styles.barText} numberOfLines={1}>
            {bar.label}
            {bar.tone !== 'idle' ? <Elapsed since={since} /> : null}
            {bar.counts ? <Text style={styles.dim}>{` · ${bar.counts}`}</Text> : null}
          </Text>
          {bar.detail ? (
            <Text style={styles.barDetail} numberOfLines={1}>
              {bar.detail}
            </Text>
          ) : null}
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textDim} />
        </Pressable>
      </Glass>
      {open ? <Card fetched={fetched} error={error} backdrop={backdrop} /> : null}
    </View>
  );
});

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

/** " · 0:42", ticking once a second; mounted only while EDITH is busy. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  return <Text>{` · ${formatElapsed(now - since)}`}</Text>;
}

function Card({ fetched, error, backdrop }: { fetched: Fetched; error: string | null; backdrop?: number | null }) {
  const d = fetched?.details;
  if (!d) {
    return (
      <Glass level="panel" backdrop={backdrop} radius={radius.l} style={styles.card}>
        <Text style={error ? styles.error : styles.dim}>{error ? `Couldn't load the details: ${error}` : 'Loading…'}</Text>
      </Glass>
    );
  }
  const ago = (t: number | null) => (t == null ? null : formatElapsed(d.ts - t));
  const e = d.edith;
  return (
    <Glass level="panel" backdrop={backdrop} radius={radius.l} style={styles.card}>
      <ScrollView style={styles.scroll} nestedScrollEnabled>
        {error ? <Text style={styles.error}>{`Couldn't refresh: ${error}`}</Text> : null}
        <Section title="EDITH">
          <Row label="State" value={[detailsLabel(e), ago(e.since)].filter(Boolean).join(' · ')} />
          {e.step ? <Row label="Step" value={e.step} mono /> : null}
          {e.ref ? <Row label="Turn" value={`${e.ref}${e.turn_started ? ` · since ${clockIST(e.turn_started)}` : ''}`} /> : null}
          <Row label="tmux" value={e.tmux} warn={e.tmux === 'down'} />
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
            <Text style={styles.dim}>No conversation yet</Text>
          )}
        </Section>
        <Section title="Agents">
          {d.agents.length ? d.agents.map((a) => <AgentRow key={a.name} agent={a} />) : <Text style={styles.dim}>No coding agents running</Text>}
        </Section>
        <Text style={styles.footer}>
          {[d.server.tag ? `Live ${d.server.tag}` : null, `up ${formatUptime(d.server.uptime)}`, `updated ${clockIST(fetched.at)} IST`].filter(Boolean).join(' · ')}
        </Text>
      </ScrollView>
    </Glass>
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
  bar: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m, paddingVertical: space.s },
  dot: { width: 10, height: 10, borderRadius: 5, marginHorizontal: 5 },
  barText: { color: colors.text, fontSize: type.size.small, flex: 1 },
  barDetail: { color: colors.textDim, fontSize: type.size.caption, maxWidth: '40%' },
  dim: { color: colors.textDim },
  card: { marginTop: space.s, padding: space.m },
  scroll: { maxHeight: 420 },
  error: { color: colors.danger, fontSize: type.size.small, marginBottom: space.s },
  section: { marginBottom: space.m },
  sectionTitle: { color: colors.textDim, fontSize: type.size.caption, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: space.xs },
  row: { flexDirection: 'row', gap: space.s, paddingVertical: 2 },
  label: { color: colors.textDim, fontSize: type.size.small, width: 84 },
  value: { color: colors.text, fontSize: type.size.small, flex: 1 },
  mono: { fontFamily: type.mono },
  warn: { color: colors.warn },
  agent: { paddingVertical: space.xs },
  agentHead: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  smallDot: { width: 8, height: 8, borderRadius: 4 },
  agentName: { color: colors.text, fontSize: type.size.small, fontWeight: '600', flexShrink: 1 },
  agentBranch: { color: colors.textDim, fontSize: type.size.caption, flex: 1 },
  agentState: { color: colors.textDim, fontSize: type.size.caption },
  agentLast: { color: colors.textDim, fontSize: type.size.caption, marginLeft: 16, marginTop: 2 },
  footer: { color: colors.textDim, fontSize: type.size.caption, textAlign: 'center' },
});
