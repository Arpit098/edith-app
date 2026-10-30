// App frame: connect gate, header, banner panels, the current screen and the bottom tab bar.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Connection, ConnectionState } from '../core/connection';
import { localEvent } from '../core/events';
import type { LoadedFeatures } from '../core/feature';
import type { FrameMeter } from '../core/ports';
import { useStore } from '../core/store';
import { ChromeContext, chrome, colors, glass, motion, radius, space, type } from '../core/theme';
import { Ambient } from '../ui/Ambient';
import { Glass, useBackdrop } from '../ui/Glass';
import { Icon } from '../ui/Icon';
import { Squish, useReduceMotion } from '../ui/motion';
import { ConnectionPill } from './ConnectionPill';
import { ConnectScreen } from './ConnectScreen';
import { linkScreen, useDeepLinks } from './links';
import { back, current, navigate, type NavState } from './navigation';
import { SettingsScreen } from './SettingsScreen';
import { ToolsScreen } from './ToolsScreen';

interface Route {
  name: string;
  title: string;
  icon: string;
  component: ComponentType;
}

const selectLink = (s: ConnectionState) => s.link;

export function Shell({ loaded, connection, meter }: { loaded: LoadedFeatures; connection: Connection; meter: FrameMeter | null }) {
  const link = useStore(connection.store, selectLink);
  if (link === 'loading') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  if (link === 'unconfigured') return <ConnectScreen connection={connection} />;
  return <Main loaded={loaded} connection={connection} meter={meter} />;
}

function Main({ loaded, connection, meter }: { loaded: LoadedFeatures; connection: Connection; meter: FrameMeter | null }) {
  const insets = useSafeAreaInsets();
  const tabNames = useMemo(() => new Set([...loaded.screens.filter((s) => s.tab).map((s) => s.name), 'tools', 'settings']), [loaded]);
  const [nav, setNav] = useState<NavState>(() => ({ tab: loaded.screens.find((s) => s.tab)?.name ?? 'tools', stack: [] }));
  const navRef = useRef(nav);
  navRef.current = nav;
  const go = useCallback((screen: string) => setNav((s) => navigate(s, screen, tabNames)), [tabNames]);

  // Routes: the features' screens, plus the shell's own Tools and Settings tabs (after the features' tabs).
  const { tabs, routes, home } = useMemo(() => {
    const own: Route[] = [
      { name: 'tools', title: 'Tools', icon: 'view-grid-outline', component: () => <ToolsScreen tools={loaded.tools} open={go} /> },
      { name: 'settings', title: 'Settings', icon: 'cog-outline', component: () => <SettingsScreen connection={connection} sections={loaded.settings} meter={meter} /> },
    ];
    const featureRoutes: Route[] = loaded.screens.map((s) => ({ name: s.name, title: s.title, icon: s.icon ?? 'circle-outline', component: s.component }));
    const all = [...featureRoutes, ...own];
    const tabList = all.filter((r) => tabNames.has(r.name));
    return { tabs: tabList, routes: new Map(all.map((r) => [r.name, r])), home: tabList[0]!.name };
  }, [loaded, connection, go, tabNames, meter]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const next = back(navRef.current, home);
      if (!next) return false; // on the home tab: Android leaves the app
      setNav(next);
      return true;
    });
    return () => sub.remove();
  }, [home]);

  // A tapped notification or Live Alerts pill: edith://live, edith://approvals.
  useDeepLinks((url) => {
    const screen = linkScreen(url, (name) => routes.has(name), home);
    if (screen) go(screen);
  });
  // A feature's own link to a screen (e.g. Settings → Train wake word).
  useEffect(() => connection.bus.on('app.open', (e) => routes.has(String(e.data.screen)) && go(String(e.data.screen)), 'shell'), [connection, routes, go]);

  const keyboard = useKeyboardVisible();
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([nav.tab]));
  useEffect(() => setVisited((v) => (v.has(nav.tab) ? v : new Set([...v, nav.tab]))), [nav.tab]);

  const top = current(nav);
  const route = routes.get(top);
  const stacked = nav.stack.length > 0;
  const Stacked = stacked ? route?.component : undefined;
  useEffect(() => connection.bus.publish(localEvent('app.screen', { name: top })), [connection, top]);

  // The header and the tab bar float over the content as glass, bending what scrolls under them.
  const backdrop = useBackdrop();
  const [headerHeight, setHeaderHeight] = useState(insets.top + chrome.headerHeight);
  const onHeaderLayout = useCallback((e: LayoutChangeEvent) => setHeaderHeight(Math.round(e.nativeEvent.layout.height)), []);
  const tabBarSpace = keyboard ? 0 : chrome.tabBarHeight + space.s * 2;
  // With the keyboard up, the tab bar is gone and the keyboard (KeyboardAvoidingView) covers the gesture area.
  const chromeInsets = useMemo(() => ({ top: headerHeight, bottom: keyboard ? 0 : insets.bottom + tabBarSpace }), [headerHeight, insets.bottom, tabBarSpace, keyboard]);

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding">
      <ChromeContext.Provider value={chromeInsets}>
        {/* The glass's backdrop: the glow and the screens (never the chrome itself). */}
        <View ref={backdrop.ref} collapsable={false} style={styles.flex}>
          <Ambient />
          {/* Tabs stay mounted once visited (keeps scroll position and input); hidden ones don't draw. */}
          {tabs
            .filter((t) => visited.has(t.name))
            .map((t) => (
              <View key={t.name} style={[styles.flex, (stacked || t.name !== nav.tab) && styles.hidden]}>
                <t.component />
              </View>
            ))}
          {Stacked ? (
            <View style={styles.flex}>
              <Stacked />
            </View>
          ) : null}
        </View>
      </ChromeContext.Provider>

      <Glass level="thick" backdrop={backdrop.tag} radius={0} edges={{ bottom: true }} style={styles.header}>
        <View onLayout={onHeaderLayout} style={{ paddingTop: insets.top }}>
          <View style={styles.headerRow}>
            {stacked ? (
              <Pressable onPress={() => setNav((s) => back(s, home) ?? s)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back" style={styles.backBtn}>
                <Icon name="arrow-left" />
              </Pressable>
            ) : null}
            <Text style={styles.title} numberOfLines={1}>
              {route?.title ?? 'EDITH'}
            </Text>
            <ConnectionPill connection={connection} onUnauthorized={() => go('settings')} />
          </View>
          {loaded.panels
            .filter((p) => p.slot === 'banner')
            .map((p, i) => (
              <p.component key={i} />
            ))}
        </View>
      </Glass>

      {keyboard ? null : <TabBar tabs={tabs} active={stacked ? null : nav.tab} onSelect={go} bottom={insets.bottom} backdrop={backdrop.tag} />}
    </KeyboardAvoidingView>
  );
}

interface TabBarProps {
  tabs: Route[];
  active: string | null;
  onSelect: (name: string) => void;
  bottom: number;
  backdrop: number | null;
}

const DROP_INSET = 6; // the droplet's gap to its tab's edges

/**
 * A floating glass pill above the gesture area. The selected tab sits in a glass droplet that
 * moves between tabs on two springs: the leading edge leaps, the trailing edge follows softer, so it
 * stretches as it goes and settles round. Transforms only (no layout per frame), on the UI thread.
 */
const TabBar = memo(function TabBar({ tabs, active, onSelect, bottom, backdrop }: TabBarProps) {
  const reduce = useReduceMotion();
  const [rowWidth, setRowWidth] = useState(0);
  const onRowLayout = useCallback((e: LayoutChangeEvent) => setRowWidth(e.nativeEvent.layout.width), []);
  const slot = tabs.length ? rowWidth / tabs.length : 0;
  const base = Math.max(1, slot - 2 * DROP_INSET);
  const index = tabs.findIndex((t) => t.name === active);
  const lead = useSharedValue(-1); // the droplet's left and right edges, px
  const trail = useSharedValue(-1);
  const shown = useSharedValue(0);
  useEffect(() => {
    if (!slot || index < 0) {
      shown.value = reduce ? 0 : withSpring(0, motion.grow); // a stacked screen: no tab is selected
      return;
    }
    const l = index * slot + DROP_INSET;
    const r = (index + 1) * slot - DROP_INSET;
    if (reduce || lead.value < 0) {
      lead.value = l;
      trail.value = r;
    } else {
      const right = l > lead.value;
      lead.value = withSpring(l, right ? motion.dropletTrail : motion.dropletLead);
      trail.value = withSpring(r, right ? motion.dropletLead : motion.dropletTrail);
    }
    shown.value = reduce ? 1 : withSpring(1, motion.grow);
  }, [index, slot, reduce, lead, trail, shown]);
  const droplet = useAnimatedStyle(() => {
    const w = Math.max(0, trail.value - lead.value);
    return {
      opacity: shown.value,
      transform: [{ translateX: lead.value + w / 2 - base / 2 }, { scaleX: w / base }, { scaleY: 1 - Math.min(0.12, Math.abs(w - base) / base / 3) }],
    };
  });
  return (
    <Glass level="regular" backdrop={backdrop} radius={radius.pill} style={[styles.tabBar, { bottom: bottom + space.s }]}>
      <View style={styles.tabRow} accessibilityRole="tablist" onLayout={onRowLayout}>
        {slot ? <Animated.View style={[styles.droplet, { width: base }, droplet]} pointerEvents="none" /> : null}
        {tabs.map((t) => {
          const on = t.name === active;
          return (
            <Squish
              key={t.name}
              outerStyle={styles.tab}
              style={styles.tabInner}
              onPress={() => onSelect(t.name)}
              accessibilityRole="tab"
              accessibilityLabel={t.title}
              accessibilityState={{ selected: on }}
            >
              <Icon name={t.icon} size={22} color={on ? colors.accent : colors.textDim} />
              <Text style={[styles.tabText, on && styles.tabTextOn]}>{t.title}</Text>
            </Squish>
          );
        })}
      </View>
    </Glass>
  );
});

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hidden: { display: 'none' },
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  header: { position: 'absolute', top: 0, left: 0, right: 0 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.l, minHeight: chrome.headerHeight },
  backBtn: { paddingRight: space.xs },
  title: { color: colors.text, fontSize: type.size.heading, fontWeight: '700', flex: 1, letterSpacing: 0.2 },
  tabBar: { position: 'absolute', left: space.l, right: space.l, height: chrome.tabBarHeight },
  tabRow: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  tab: { flex: 1, alignSelf: 'stretch' },
  tabInner: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  droplet: {
    position: 'absolute',
    left: 0,
    top: DROP_INSET,
    bottom: DROP_INSET,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopColor: glass.thin.edge[0],
    borderLeftColor: glass.thin.edge[0],
    borderRightColor: glass.thin.edge[1],
    borderBottomColor: glass.thin.edge[1],
  },
  tabText: { color: colors.textDim, fontSize: type.size.caption },
  tabTextOn: { color: colors.accent, fontWeight: '600' },
});
