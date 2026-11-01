// Settings: a grouped list (like the phone's own settings), each row an icon, a title and one line of
// live state. A row opens its section on its own page, with a back header; Android back closes it.
// The shell adds two sections of its own: the server connection and the Developer page (frame meter).

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Connection, ConnectionState } from '../core/connection';
import type { SettingsSection } from '../core/feature';
import { str } from '../core/guards';
import { PageBackContext, type PageBack } from '../core/pageBack';
import type { FrameMeter, FrameReport } from '../core/ports';
import { createStore, useStore, type Store } from '../core/store';
import { colors, space, type, useChrome, useGlass, useTheme } from '../core/theme';
import { Button } from '../ui/Button';
import { Glass } from '../ui/Glass';
import { Icon } from '../ui/Icon';
import { SlideIn } from '../ui/motion';
import { describeLink } from './ConnectionPill';
import { DEFAULT_ICON, groupSections, type SettingsGroupView } from './settingsGroups';

const selectState = (s: ConnectionState) => s;

/** The connection row's line: short, unlike describeLink's full sentence. */
export function linkSummary(s: Pick<ConnectionState, 'link' | 'baseUrl'>): string {
  const host = s.baseUrl?.replace(/^https?:\/\//i, '').replace(/[:/].*$/, '');
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

const GLASS_MODE = { shader: 'refraction (Android 13+)', blur: 'blur (Android 12)', flat: 'flat' } as const;
const GLASS_SHORT = { shader: 'refraction', blur: 'blur', flat: 'flat' } as const;

function useFramesSummary(): string {
  return `Frame meter · glass: ${GLASS_SHORT[useGlass().mode]}`;
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
    own.push({ title: 'Developer', group: 'app', icon: 'speedometer', order: 90, component: () => <FrameSection meter={meter} />, summary: useFramesSummary });
  }
  return own;
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
  const groups = useMemo(() => groupSections(all), [all]);
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
        <SettingsList groups={groups} onOpen={setOpen} />
      </View>
      {page ? (
        <PageBackContext.Provider value={backContext}>
          <SettingsPage key={page.title} section={page} onBack={() => setOpen(null)} />
        </PageBackContext.Provider>
      ) : null}
    </>
  );
}

function SettingsList({ groups, onOpen }: { groups: SettingsGroupView[]; onOpen: (title: string) => void }) {
  const insets = useChrome();
  return (
    <ScrollView contentContainerStyle={[styles.body, { paddingTop: insets.top + space.l, paddingBottom: insets.bottom + space.l }]}>
      {groups.map((g) => (
        <View key={g.id} style={styles.group}>
          <Text style={styles.heading} accessibilityRole="header">
            {g.title}
          </Text>
          <Glass level="regular" rim style={styles.card}>
            {g.sections.map((s, i) => (
              <SettingsRow key={s.title} section={s} first={i === 0} onPress={() => onOpen(s.title)} />
            ))}
          </Glass>
        </View>
      ))}
    </ScrollView>
  );
}

function SettingsRow({ section, first, onPress }: { section: SettingsSection; first: boolean; onPress: () => void }) {
  const useSummary = section.summary ?? noSummary; // one section per row (keyed by title): the same hook every render
  const summary = useSummary();
  const { accent } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: colors.ripple }}
      accessibilityRole="button"
      accessibilityLabel={summary ? `${section.title}, ${summary}` : section.title}
      accessibilityHint={`Opens ${section.title}`}
      style={[styles.row, !first && styles.divider]}
    >
      <Icon name={section.icon ?? DEFAULT_ICON} size={22} color={accent} />
      <View style={styles.flex}>
        <Text style={styles.title} numberOfLines={1}>
          {section.title}
        </Text>
        {summary ? (
          <Text style={styles.summary} numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
      </View>
      <Icon name="chevron-right" size={20} color={colors.textDim} />
    </Pressable>
  );
}

const noSummary = () => null;

function SettingsPage({ section, onBack }: { section: SettingsSection; onBack: () => void }) {
  const insets = useChrome();
  if (section.layout === 'full') {
    // An editor: its own layout under the back header, edge to edge, no scrolling page around it.
    return (
      <SlideIn style={[styles.flex, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={[styles.back, styles.fullBack]}>
          <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back to Settings">
            <Icon name="arrow-left" size={22} />
          </Pressable>
          <Text style={styles.pageTitle} numberOfLines={1} accessibilityRole="header">
            {section.title}
          </Text>
        </View>
        <View style={styles.flex}>
          <section.component />
        </View>
      </SlideIn>
    );
  }
  return (
    <SlideIn style={styles.flex}>
      <ScrollView contentContainerStyle={[styles.body, { paddingTop: insets.top + space.m, paddingBottom: insets.bottom + space.l }]} keyboardShouldPersistTaps="handled">
        {/* The title is beside the button, not in it: TalkBack reads it as the page's heading. */}
        <View style={styles.back}>
          <Pressable onPress={onBack} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back to Settings">
            <Icon name="arrow-left" size={22} />
          </Pressable>
          <Text style={styles.pageTitle} numberOfLines={1} accessibilityRole="header">
            {section.title}
          </Text>
        </View>
        <Glass level="regular" rim style={styles.section}>
          <section.component />
        </Glass>
      </ScrollView>
    </SlideIn>
  );
}

function ConnectionSection({ connection }: { connection: Connection }) {
  const state = useStore(connection.store, selectState);
  const forget = () =>
    Alert.alert('Change server?', 'This disconnects and deletes the saved token from this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: () => void connection.forget() },
    ]);
  return (
    <>
      <Text style={styles.value} selectable>
        {state.baseUrl}
      </Text>
      <Text style={styles.dim}>{describeLink(state)}</Text>
      <View style={styles.actions}>
        {state.link !== 'open' ? <Button small label="Reconnect now" icon="refresh" onPress={() => connection.retry()} /> : null}
        <Button small label="Change server" icon="logout" variant="danger" onPress={forget} />
      </View>
    </>
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
    <>
      <Text style={styles.dim}>Glass: {GLASS_MODE[mode]}</Text>
      {report ? (
        <Text style={styles.value} selectable>
          {describeFrames(report)}
        </Text>
      ) : (
        <Text style={styles.dim}>{running ? 'Measuring: scroll and switch tabs, then come back and stop.' : 'Measure frame times while you use the app.'}</Text>
      )}
      <View style={styles.actions}>
        <Button small label={running ? 'Stop measuring' : 'Measure frames'} icon={running ? 'stop' : 'speedometer'} onPress={toggle} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hidden: { display: 'none' },
  body: { paddingHorizontal: space.l, gap: space.m },
  group: { gap: space.s },
  card: { paddingVertical: space.xs, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m, minHeight: 60 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  section: { padding: space.l, gap: space.xs },
  back: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: space.xs },
  fullBack: { paddingHorizontal: space.l, paddingVertical: space.s },
  pageTitle: { color: colors.text, fontSize: type.size.title, fontWeight: '700', flex: 1 },
  heading: { color: colors.textDim, fontSize: type.size.caption, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: space.xs },
  title: { color: colors.text, fontSize: type.size.body, fontWeight: '600' },
  summary: { color: colors.textDim, fontSize: type.size.small, marginTop: 2 },
  value: { color: colors.text, fontSize: type.size.title },
  dim: { color: colors.textDim, fontSize: type.size.small },
  actions: { flexDirection: 'row', gap: space.s, marginTop: space.s, flexWrap: 'wrap' },
});
