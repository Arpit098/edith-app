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
import { colors, GlassContext, glassMode, type GlassSettings } from './core/theme';
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
  const loaded = loadFeatures(features, { bus, ports: { transport, storage, data, installer, ota, recorder, stt, media: createExpoMediaPicker(), status: system?.status, notifier: system?.notifier, visibility }, api, connection });
  return { connection, loaded, glass: createAndroidGlass() };
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
    return () => {
      app.connection.dispose();
      app.loaded.cleanup();
    };
  }, [app]);
  const glass = useGlassSettings(app.glass);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <GlassContext.Provider value={glass}>
        <View style={styles.root}>
          <Shell loaded={app.loaded} connection={app.connection} meter={app.glass?.meter ?? null} />
        </View>
      </GlassContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
