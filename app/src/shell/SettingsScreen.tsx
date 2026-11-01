// Settings, in the shape of Arpit's reference (1 Nov): a card at the top for EDITH and the link (it
// opens the server connection), then sections with sentence-case titles, each a glass card of compact
// rows (icon, label, dim state, chevron), switches right in the row for settings that are just on or
// off, and the one bottom action (Change server) as a full-width pill. A row opens its section on its
// own page, with a back header; Android back closes it. The pages are built from ui/SettingsRows too.
// The shell adds two sections of its own: the server connection and the Developer page (frame meter).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { LINK_TONE, type Connection, type ConnectionState } from '../core/connection';
import type { SettingsSection } from '../core/feature';
import { str } from '../core/guards';
import { PageBackContext, type PageBack } from '../core/pageBack';
import type { FrameMeter, FrameReport } from '../core/ports';
import { createStore, shallowEqual, useStore, type Store } from '../core/store';
import { colors, space, type, useChrome, useGlass } from '../core/theme';
import { Icon } from '../ui/Icon';
import { SlideIn } from '../ui/motion';
import { Helper, PillButton, Row, Section, SettingsPageBody, SummaryCard, SwitchRow } from '../ui/SettingsRows';
import { ThinkingBubble } from '../ui/ThinkingBubble';
import { describeLink } from './ConnectionPill';
import { DEFAULT_ICON, groupSections } from './settingsGroups';

const selectState = (s: ConnectionState) => s;
const selectCard = (s: ConnectionState) => ({ link: s.link, baseUrl: s.baseUrl });

/** The host in a base URL: "http://100.78.124.98:8787" → "100.78.124.98". */
export function hostOf(baseUrl: string | null | undefined): string | null {
  return baseUrl?.replace(/^https?:\/\//i, '').replace(/[:/].*$/, '') || null;
}

/** The connection row's line: short, unlike describeLink's full sentence. */
export function linkSummary(s: Pick<ConnectionState, 'link' | 'baseUrl'>): string {
  const host = hostOf(s.baseUrl);
  switch (s.link) {
    case 'open':
      return host ? `Connected · ${host}` : 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'offline':
      return 'Offline';
    case 'unauthorized':
      return 'Token rejected';
    case 'loading':
      return 'Loading…';
    case 'unconfigured':
      return 'Not set up';
  }
}

/** The top card's line: the link in a word, then what the sections add ("Connected · Interseqt active"). */
export function cardLine(link: ConnectionState['link'], badges: readonly (string | null | undefined)[]): string {
  return [linkSummary({ link, baseUrl: null }), ...badges].filter(Boolean).join(' · ');
}

const GLASS_MODE = { shader: 'refraction (Android 13+)', blur: 'blur (Android 12)', flat: 'flat' } as const;
const GLASS_SHORT = { shader: 'refraction', blur: 'blur', flat: 'flat' } as const;

function useFramesSummary(): string {
  return `Glass: ${GLASS_SHORT[useGlass().mode]}`;
}

export const SERVER_CONNECTION = 'Server connection';

/** The shell's own sections, in the same shape as the features'. */
export function shellSections(connection: Connection, meter: FrameMeter | null): SettingsSection[] {
  const useLinkSummary = () => useStore(connection.store, linkSummary);
  const own: SettingsSection[] = [
    {
      title: SERVER_CONNECTION,
      group: 'connection',
      icon: 'server-network',
      order: 0,
      component: () => <ConnectionSection connection={connection} />,
      summary: useLinkSummary,
    },
  ];
  if (meter) {
    own.push({ title: 'Developer', group: 'about', icon: 'speedometer', order: 90, component: () => <FrameSection meter={meter} />, summary: useFramesSummary });
  }
  return own;
}

/** Disconnect and delete the saved token, after asking. */
function confirmChangeServer(connection: Connection) {
  Alert.alert('Change server?', 'This disconnects and deletes the saved token from this phone.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Disconnect', style: 'destructive', onPress: () => void connection.forget() },
  ]);
}

/** Whether Settings is the screen on top (tabs stay mounted when hidden: back must not act from behind). */
function useOnScreen(connection: Connection): boolean {
  const [on, setOn] = useState(true); // it mounts when it's opened
  useEffect(() => connection.bus.on('app.screen', (e) => setOn(str(e.data.name) === 'settings'), 'settings'), [connection]);
  return on;
}

/** The page Settings shows (a section's title), or null for the list. The shell owns it, so opening
 *  Settings from outside (a link, the token-rejected pill) can pick the page before Settings mounts. */
export type SettingsPageStore = Store<string | null>;

const selectPage = (p: string | null) => p;

export function SettingsScreen({ connection, sections, meter, open: openStore }: { connection: Connection; sections: SettingsSection[]; meter: FrameMeter | null; open?: SettingsPageStore }) {
  const all = useMemo(() => [...shellSections(connection, meter), ...sections], [connection, meter, sections]);
  const [ownStore] = useState(() => openStore ?? createStore<string | null>(null));
  const open = useStore(ownStore, selectPage);
  const setOpen = ownStore.set;
  const page = open === null ? undefined : all.find((s) => s.title.toLowerCase() === open.toLowerCase()); // a link's page is lower case
  const onScreen = useOnScreen(connection);

  // The page may take Android back first (e.g. Appearance closes its sheet before leaving).
  const pageBack = useRef<PageBack | null>(null);
  const backContext = useMemo(() => ({ set: (h: PageBack | null) => void (pageBack.current = h) }), []);
  useEffect(() => {
    if (!page || !onScreen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (pageBack.current?.()) return true;
      setOpen(null);
      return true; // registered after the shell's, so it is asked first
    });
    return () => sub.remove();
  }, [page, onScreen]);

  return (
    <>
      {/* The list stays mounted under a page, so it comes back where it was scrolled to. */}
      <View style={[styles.flex, page && styles.hidden]}>
        <SettingsList connection={connection} all={all} onOpen={setOpen} />
      </View>
      {page ? (
        <PageBackContext.Provider value={backContext}>
          <SettingsPage key={page.title} section={page} onBack={() => setOpen(null)} />
        </PageBackContext.Provider>
      ) : null}
    </>
  );
}

function SettingsList({ connection, all, onOpen }: { connection: Connection; all: SettingsSection[]; onOpen: (title: string) => void }) {
  const insets = useChrome();
  // The server connection is the top card, not a row.
  const groups = useMemo(() => groupSections(all.filter((s) => s.title !== SERVER_CONNECTION)), [all]);
  const badges = useMemo(() => all.filter((s) => s.badge), [all]);
  return (
    <ScrollView contentContainerStyle={[styles.body, { paddingTop: insets.top + space.l, paddingBottom: insets.bottom + space.l }]}>
      <TopCard connection={connection} badges={badges} onOpen={() => onOpen(SERVER_CONNECTION)} />
      {groups.map((g) => (
        <Section key={g.id} title={g.title}>
          {g.sections.map((s) => (
            <ListRow key={s.title} section={s} onOpen={() => onOpen(s.title)} />
          ))}
        </Section>
      ))}
      <PillButton label="Change server" icon="logout" variant="danger" onPress={() => confirmChangeServer(connection)} accessibilityHint="Disconnects and deletes the saved token" />
    </ScrollView>
  );
}

function TopCard({ connection, badges, onOpen }: { connection: Connection; badges: SettingsSection[]; onOpen: () => void }) {
  const { link } = useStore(connection.store, selectCard, shallowEqual);
  // One hook per section with a badge; `badges` is fixed for this list (memoized from the sections).
  const words = badges.map((s) => s.badge!());
  const tone = LINK_TONE[link];
  return (
    <SummaryCard
      leading={<ThinkingBubble active={false} size={48} />}
      title="E.D.I.T.H"
      subtitle={cardLine(link, words)}
      tone={tone === 'ok' ? undefined : tone === 'textDim' ? undefined : tone}
      onPress={onOpen}
      accessibilityHint={`Opens ${SERVER_CONNECTION}`}
    />
  );
}

/** A row in the list: a switch when the section has one right now, else its state as dim text. */
function ListRow({ section, onOpen }: { section: SettingsSection; onOpen: () => void }) {
  const useSummary = section.summary ?? noSummary; // one section per row (keyed by title): the same hooks every render
  const useToggle = section.toggle ?? noToggle;
  const summary = useSummary();
  const toggle = useToggle();
  const icon = section.icon ?? DEFAULT_ICON;
  if (toggle) {
    return <SwitchRow icon={icon} label={section.title} value={toggle.on} onChange={toggle.set} disabled={toggle.disabled} detail={toggle.detail} onOpen={onOpen} openHint={`Opens ${section.title}`} />;
  }
  return <Row icon={icon} label={section.title} value={summary} onPress={onOpen} accessibilityHint={`Opens ${section.title}`} />;
}

const noSummary = () => null;
const noToggle = () => null;

function BackHeader({ title, onBack, style }: { title: string; onBack: () => void; style?: object }) {
  // The title is beside the button, not in it: TalkBack reads it as the page's heading.
  return (
    <View style={[styles.back, style]}>
      <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back to Settings">
        <Icon name="arrow-left" size={22} />
      </Pressable>
      <Text style={styles.pageTitle} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
    </View>
  );
}

function SettingsPage({ section, onBack }: { section: SettingsSection; onBack: () => void }) {
  const insets = useChrome();
  if (section.layout === 'full') {
    // An editor: its own layout under the back header, edge to edge, no scrolling page around it.
    return (
      <SlideIn style={[styles.flex, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <BackHeader title={section.title} onBack={onBack} style={styles.fullBack} />
        <View style={styles.flex}>
          <section.component />
        </View>
      </SlideIn>
    );
  }
  return (
    <SlideIn style={styles.flex}>
      <ScrollView contentContainerStyle={[styles.body, { paddingTop: insets.top + space.m, paddingBottom: insets.bottom + space.l }]} keyboardShouldPersistTaps="handled">
        <BackHeader title={section.title} onBack={onBack} />
        <section.component />
      </ScrollView>
    </SlideIn>
  );
}

function ConnectionSection({ connection }: { connection: Connection }) {
  const state = useStore(connection.store, selectState);
  const tone = LINK_TONE[state.link];
  return (
    <SettingsPageBody>
      <SummaryCard icon="server-network" title={hostOf(state.baseUrl) ?? 'No server'} subtitle={describeLink(state)} tone={tone === 'textDim' ? undefined : tone} />
      <Section title="Server" footer="Change server disconnects and deletes the saved token from this phone.">
        <Row icon="link-variant" label="Address" value={state.baseUrl ?? 'Not set'} selectable />
        <Row icon="lan-connect" label="Status" value={linkSummary({ link: state.link, baseUrl: null })} />
        {state.link !== 'open' ? <Row icon="refresh" label="Reconnect now" tone="accent" onPress={() => connection.retry()} chevron={false} /> : null}
      </Section>
      <PillButton label="Change server" icon="logout" variant="danger" onPress={() => confirmChangeServer(connection)} />
    </SettingsPageBody>
  );
}

export function describeFrames(r: FrameReport): string {
  return [
    `${r.frames} frames in ${r.seconds.toFixed(0)} s at ${r.refreshHz.toFixed(0)} Hz`,
    `p50 ${r.p50Ms.toFixed(1)} ms · p95 ${r.p95Ms.toFixed(1)} ms · p99 ${r.p99Ms.toFixed(1)} ms`,
    `janky ${r.jankyFrames} (${r.jankyPercent.toFixed(1)} %)`,
  ].join('\n');
}

/** Frame times while Arpit uses the app (scroll, switch tabs): how much the glass costs on this phone. */
function FrameSection({ meter }: { meter: FrameMeter }) {
  const { mode } = useGlass();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<FrameReport | null>(null);
  const toggle = () => {
    if (!running) {
      meter.start();
      setReport(null);
      setRunning(true);
      return;
    }
    setRunning(false);
    void meter.stop().then(setReport, () => setReport(null));
  };
  return (
    <SettingsPageBody>
      <SummaryCard icon="speedometer" title="Frame meter" subtitle={running ? 'Measuring…' : `Glass: ${GLASS_MODE[mode]}`} tone={running ? 'warn' : undefined} />
      {report ? (
        <Section title="Last measurement">
          <Row icon="filmstrip" label="Frames" value={`${report.frames} in ${report.seconds.toFixed(0)} s · ${report.refreshHz.toFixed(0)} Hz`} />
          <Row icon="timer-outline" label="Frame time" value={`p50 ${report.p50Ms.toFixed(1)} · p95 ${report.p95Ms.toFixed(1)} · p99 ${report.p99Ms.toFixed(1)} ms`} />
          <Row icon="alert-outline" label="Janky" value={`${report.jankyFrames} (${report.jankyPercent.toFixed(1)} %)`} />
        </Section>
      ) : (
        <Helper>{running ? 'Measuring: scroll and switch tabs, then come back and stop.' : 'Measure frame times while you use the app.'}</Helper>
      )}
      <PillButton label={running ? 'Stop measuring' : 'Measure frames'} icon={running ? 'stop' : 'speedometer'} variant="primary" onPress={toggle} />
    </SettingsPageBody>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hidden: { display: 'none' },
  body: { paddingHorizontal: space.l, gap: space.l },
  back: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: space.xs },
  fullBack: { paddingHorizontal: space.l, paddingVertical: space.s },
  pageTitle: { color: colors.text, fontSize: type.size.title, fontWeight: '700', flex: 1 },
});
