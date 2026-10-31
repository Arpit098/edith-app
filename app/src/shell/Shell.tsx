// App frame: connect gate, header (title, connection dot, the navigation menu), banner panels and the current screen.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Connection, ConnectionState } from '../core/connection';
import { localEvent } from '../core/events';
import type { LoadedFeatures } from '../core/feature';
import type { FrameMeter } from '../core/ports';
import { createStore, useStore } from '../core/store';
import { ChromeContext, chrome, colors, space, titleGlow, type } from '../core/theme';
import { Ambient } from '../ui/Ambient';
import { Glass, useBackdrop } from '../ui/Glass';
import { Icon } from '../ui/Icon';
import { ConnectionPill } from './ConnectionPill';
import { ConnectScreen } from './ConnectScreen';
import { linkTarget, useDeepLinks } from './links';
import { MenuButton, NavMenu } from './NavMenu';
import { back, current, navigate, type NavState } from './navigation';
import { SERVER_CONNECTION, SettingsScreen } from './SettingsScreen';
import { ToolsScreen } from './ToolsScreen';

interface Route {
  name: string;
  title: string;
  icon: string;
  component: ComponentType;
}

const selectLink = (s: ConnectionState) => s.link;
const APP_TITLE = 'E.D.I.T.H';

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
  // Settings opened from outside (a link, a feature, the token-rejected pill) shows the page asked
  // for, or the list: never a page left open earlier. Switching tabs by hand keeps the page.
  const [settingsPage] = useState(() => createStore<string | null>(null));
  const open = useCallback(
    (screen: string, page: string | null = null) => {
      if (screen === 'settings') settingsPage.set(page);
      go(screen);
    },
    [go, settingsPage],
  );

  // Routes: the features' screens, plus the shell's own Tools and Settings tabs (after the features' tabs).
  const { tabs, routes, home } = useMemo(() => {
    const own: Route[] = [
      { name: 'tools', title: 'Tools', icon: 'view-grid-outline', component: () => <ToolsScreen tools={loaded.tools} open={go} /> },
      { name: 'settings', title: 'Settings', icon: 'cog-outline', component: () => <SettingsScreen connection={connection} sections={loaded.settings} meter={meter} open={settingsPage} /> },
    ];
    const featureRoutes: Route[] = loaded.screens.map((s) => ({ name: s.name, title: s.title, icon: s.icon ?? 'circle-outline', component: s.component }));
    const all = [...featureRoutes, ...own];
    const tabList = all.filter((r) => tabNames.has(r.name));
    return { tabs: tabList, routes: new Map(all.map((r) => [r.name, r])), home: tabList[0]!.name };
  }, [loaded, connection, go, tabNames, meter, settingsPage]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const next = back(navRef.current, home);
      if (!next) return false; // on the home tab: Android leaves the app
      setNav(next);
      return true;
    });
    return () => sub.remove();
  }, [home]);

  // A tapped notification or Live Alerts pill: edith://live, edith://approvals, edith://settings/updates.
  useDeepLinks((url) => {
    const target = linkTarget(url, (name) => routes.has(name), home);
    if (target) open(target.screen, target.page);
  });
  // A feature's own link to a screen (e.g. Settings → Train wake word).
  useEffect(
    () => connection.bus.on('app.open', (e) => routes.has(String(e.data.screen)) && open(String(e.data.screen), typeof e.data.page === 'string' ? e.data.page : null), 'shell'),
    [connection, routes, open],
  );

  const keyboard = useKeyboardVisible();
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([nav.tab]));
  useEffect(() => setVisited((v) => (v.has(nav.tab) ? v : new Set([...v, nav.tab]))), [nav.tab]);

  const top = current(nav);
  const route = routes.get(top);
  const stacked = nav.stack.length > 0;
  const Stacked = stacked ? route?.component : undefined;
  useEffect(() => connection.bus.publish(localEvent('app.screen', { name: top })), [connection, top]);

  // The header floats over the content as glass, bending what scrolls under it. Nothing floats at
  // the bottom: screens only keep clear of the gesture area (the keyboard covers it when it's up).
  const backdrop = useBackdrop();
  const [headerHeight, setHeaderHeight] = useState(insets.top + chrome.headerHeight);
  const onHeaderLayout = useCallback((e: LayoutChangeEvent) => setHeaderHeight(Math.round(e.nativeEvent.layout.height)), []);
  const chromeInsets = useMemo(() => ({ top: headerHeight, bottom: keyboard ? 0 : insets.bottom }), [headerHeight, insets.bottom, keyboard]);

  // The navigation menu (top right). Any navigation closes it, a deep link included.
  const [menuOpen, setMenuOpen] = useState(false);
  const toggleMenu = useCallback(() => setMenuOpen((o) => !o), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const pick = useCallback((name: string) => {
    setMenuOpen(false);
    go(name);
  }, [go]);
  useEffect(() => setMenuOpen(false), [top]);

  // The header's left side: a feature's chip (the live session's status), else the connection dot.
  const headerPanel = useMemo(() => loaded.panels.find((p) => p.slot === 'header'), [loaded]);
  const HeaderPanel = headerPanel?.component;
  const HeaderOverlay = headerPanel?.overlay;

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
          {/* [● bubble 0:42]      E.D.I.T.H      [☰] (plans/ui-next.md §2); other screens show their own title. */}
          <View style={styles.headerRow}>
            {/* The title in off-white with the logo's soft blue glow (titleGlow); E.D.I.T.H on the home screen. */}
            <Text style={styles.title} numberOfLines={1} accessibilityRole="header" pointerEvents="none">
              {top === home || !route ? APP_TITLE : route.title}
            </Text>
            {stacked ? (
              <Pressable onPress={() => setNav((s) => back(s, home) ?? s)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Back" style={styles.backBtn}>
                <Icon name="arrow-left" />
              </Pressable>
            ) : null}
            {HeaderPanel ? <HeaderPanel top={headerHeight} backdrop={backdrop.tag} /> : <ConnectionPill connection={connection} onUnauthorized={() => open('settings', SERVER_CONNECTION)} />}
            <View style={styles.flex} />
            <MenuButton open={menuOpen} onPress={toggleMenu} />
          </View>
          {loaded.panels
            .filter((p) => p.slot === 'banner')
            .map((p, i) => (
              <p.component key={i} top={headerHeight} backdrop={backdrop.tag} />
            ))}
        </View>
      </Glass>

      <View style={styles.menuSlot} pointerEvents="box-none">
        {HeaderOverlay ? <HeaderOverlay top={headerHeight} backdrop={backdrop.tag} /> : null}
        <NavMenu open={menuOpen} items={tabs} current={stacked ? null : nav.tab} top={headerHeight} backdrop={backdrop.tag} onSelect={pick} onClose={closeMenu} />
      </View>
    </KeyboardAvoidingView>
  );
}

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
  // Centred over the whole row whatever sits either side; its glow is a static text shadow (titleGlow).
  title: { position: 'absolute', left: 96, right: 96, textAlign: 'center', color: colors.text, fontSize: type.size.heading, fontWeight: '700', letterSpacing: 1.5, ...titleGlow },
  menuSlot: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
});
