// App frame: connect gate, header, banner panels, the current screen and the bottom tab bar.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { ActivityIndicator, BackHandler, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Connection, ConnectionState } from '../core/connection';
import type { LoadedFeatures } from '../core/feature';
import { useStore } from '../core/store';
import { Icon } from '../ui/Icon';
import { colors, space } from '../ui/theme';
import { ConnectionPill } from './ConnectionPill';
import { ConnectScreen } from './ConnectScreen';
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

export function Shell({ loaded, connection }: { loaded: LoadedFeatures; connection: Connection }) {
  const link = useStore(connection.store, selectLink);
  if (link === 'loading') {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.accent} size="large" />
      </View>
    );
  }
  if (link === 'unconfigured') return <ConnectScreen connection={connection} />;
  return <Main loaded={loaded} connection={connection} />;
}

function Main({ loaded, connection }: { loaded: LoadedFeatures; connection: Connection }) {
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
      { name: 'settings', title: 'Settings', icon: 'cog-outline', component: () => <SettingsScreen connection={connection} sections={loaded.settings} /> },
    ];
    const featureRoutes: Route[] = loaded.screens.map((s) => ({ name: s.name, title: s.title, icon: s.icon ?? 'circle-outline', component: s.component }));
    const all = [...featureRoutes, ...own];
    const tabList = all.filter((r) => tabNames.has(r.name));
    return { tabs: tabList, routes: new Map(all.map((r) => [r.name, r])), home: tabList[0]!.name };
  }, [loaded, connection, go, tabNames]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const next = back(navRef.current, home);
      if (!next) return false; // on the home tab: Android leaves the app
      setNav(next);
      return true;
    });
    return () => sub.remove();
  }, [home]);

  const keyboard = useKeyboardVisible();
  const [visited, setVisited] = useState<ReadonlySet<string>>(() => new Set([nav.tab]));
  useEffect(() => setVisited((v) => (v.has(nav.tab) ? v : new Set([...v, nav.tab]))), [nav.tab]);

  const top = current(nav);
  const route = routes.get(top);
  const stacked = nav.stack.length > 0;
  const Stacked = stacked ? route?.component : undefined;

  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding">
      <View style={[styles.header, { paddingTop: insets.top }]}>
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
      <View style={styles.flex}>
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
      {keyboard ? null : <TabBar tabs={tabs} active={stacked ? null : nav.tab} onSelect={go} bottom={insets.bottom} />}
    </KeyboardAvoidingView>
  );
}

const TabBar = memo(function TabBar({ tabs, active, onSelect, bottom }: { tabs: Route[]; active: string | null; onSelect: (name: string) => void; bottom: number }) {
  return (
    <View style={[styles.tabBar, { paddingBottom: bottom }]} accessibilityRole="tablist">
      {tabs.map((t) => {
        const on = t.name === active;
        return (
          <Pressable key={t.name} style={styles.tab} onPress={() => onSelect(t.name)} accessibilityRole="tab" accessibilityLabel={t.title} accessibilityState={{ selected: on }} android_ripple={{ color: '#ffffff11', borderless: true }}>
            <Icon name={t.icon} size={24} color={on ? colors.accent : colors.textDim} />
            <Text style={[styles.tabText, on && styles.tabTextOn]}>{t.title}</Text>
          </Pressable>
        );
      })}
    </View>
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
  header: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingHorizontal: space.m, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, backgroundColor: colors.bg },
  backBtn: { paddingRight: space.xs },
  title: { color: colors.text, fontSize: 20, fontWeight: '700', flex: 1, paddingVertical: space.m },
  tabBar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, backgroundColor: colors.surface },
  tab: { flex: 1, alignItems: 'center', paddingTop: space.s, paddingBottom: space.s, gap: 2 },
  tabText: { color: colors.textDim, fontSize: 11 },
  tabTextOn: { color: colors.accent },
});
