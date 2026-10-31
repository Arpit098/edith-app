// Composition root: the only place that picks adapters and wires them to core and the features.

import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createAndroidInstaller } from './adapters/installer/android';
import { createAndroidGlass, type AndroidGlass } from './adapters/glass/android';
import { createExpoMediaPicker } from './adapters/media/expo';
import { createAndroidRecorder } from './adapters/recorder/android';
import { createAsyncStorage } from './adapters/storage/async-storage';
import { createSecureStorage } from './adapters/storage/secure-store';
import { createServerWhisper } from './adapters/stt/server-whisper';
import { createAndroidSystem } from './adapters/system/android';
import { createEdithApiTransport } from './adapters/transport/edith-api';
import { createExpoOtaUpdates } from './adapters/updates/expo-updates';
import { createAppStateVisibility } from './adapters/visibility/react-native';
import { createApi } from './core/api';
import { Connection } from './core/connection';
import { EventBus } from './core/events';
import { loadFeatures } from './core/feature';
import { createAppearanceStore, type AppearanceStore } from './core/appearance';
import { useStore } from './core/store';
import { AppearanceContext, GlassContext, glassMode, resolveTheme, ThemeContext, type AppearanceControl, type GlassSettings, type Theme } from './core/theme';
import { features } from './features';
import { Shell } from './shell/Shell';

function boot() {
  const transport = createEdithApiTransport();
  const storage = createSecureStorage();
  const data = createAsyncStorage();
  const installer = createAndroidInstaller() ?? undefined;
  const ota = createExpoOtaUpdates();
  const recorder = createAndroidRecorder() ?? undefined;
  const stt = createServerWhisper(transport);
  const system = createAndroidSystem();
  const visibility = createAppStateVisibility();
  const bus = new EventBus();
  const api = createApi(transport);
  const connection = new Connection(transport, storage, bus);
  const loaded = loadFeatures(features, { bus, ports: { transport, storage, data, installer, ota, recorder, stt, media: createExpoMediaPicker(), status: system?.status, notifier: system?.notifier, push: system?.push, visibility }, api, connection });
  return { connection, loaded, visibility, glass: createAndroidGlass(), appearance: createAppearanceStore(data) };
}

/**
 * The active theme from the chosen appearance, applied at once (a change re-renders through the
 * context; themed style sheets are built once per theme). "Reduce transparency", where the system
 * has it (iOS; Android reports false), makes every surface solid.
 */
function useTheme(appearance: AppearanceStore): { theme: Theme; control: AppearanceControl } {
  const chosen = useStore(appearance.store, (a) => a);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceTransparencyEnabled?.().then(setReduceTransparency, () => {});
    const sub = AccessibilityInfo.addEventListener?.('reduceTransparencyChanged', setReduceTransparency);
    return () => sub?.remove();
  }, []);
  const theme = useMemo(() => resolveTheme(chosen, reduceTransparency), [chosen, reduceTransparency]);
  const control = useMemo(() => ({ appearance: chosen, set: appearance.set }), [chosen, appearance]);
  return { theme, control };
}

/** Real glass only where it's cheap and possible (glassMode), and motion as Android's settings say. */
function useGlassSettings(native: AndroidGlass | null): GlassSettings {
  const [saving, setSaving] = useState(() => native?.power.powerSave() ?? false);
  useEffect(() => native?.power.onPowerSaveChange(setSaving), [native]);
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion, () => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);
  const mode = glassMode(native ? native.power.sdkInt : null, saving);
  return useMemo(() => ({ mode, View: native?.View ?? null, reduceMotion }), [mode, native, reduceMotion]);
}

export default function App() {
  const [app] = useState(boot);
  useEffect(() => {
    void app.connection.load();
    void app.appearance.load();
    // Leaving the app: write a pending appearance change now (Android may kill the app before its timer).
    const off = app.visibility.onChange((active) => {
      if (!active) app.appearance.flush();
    });
    return () => {
      off();
      app.connection.dispose();
      app.loaded.cleanup();
      app.appearance.dispose();
    };
  }, [app]);
  const glass = useGlassSettings(app.glass);
  const { theme, control } = useTheme(app.appearance);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <AppearanceContext.Provider value={control}>
        <ThemeContext.Provider value={theme}>
          <GlassContext.Provider value={glass}>
            <View style={[styles.root, { backgroundColor: theme.bg }]}>
              <Shell loaded={app.loaded} connection={app.connection} meter={app.glass?.meter ?? null} />
            </View>
          </GlassContext.Provider>
        </ThemeContext.Provider>
      </AppearanceContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
