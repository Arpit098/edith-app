// Composition root: the only place that picks adapters and wires them to core and the features.

import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createAndroidInstaller } from './adapters/installer/android';
import { createSecureStorage } from './adapters/storage/secure-store';
import { createAndroidSystem } from './adapters/system/android';
import { createEdithApiTransport } from './adapters/transport/edith-api';
import { createExpoOtaUpdates } from './adapters/updates/expo-updates';
import { createApi } from './core/api';
import { Connection } from './core/connection';
import { EventBus } from './core/events';
import { loadFeatures } from './core/feature';
import type { DevicePower } from './core/ports';
import { colors, GlassContext } from './core/theme';
import { features } from './features';
import { Shell } from './shell/Shell';

const BLUR_MIN_SDK = 31; // RenderEffect blur: Android 12+

function boot() {
  const transport = createEdithApiTransport();
  const storage = createSecureStorage();
  const installer = createAndroidInstaller() ?? undefined;
  const ota = createExpoOtaUpdates();
  const system = createAndroidSystem();
  const bus = new EventBus();
  const api = createApi(transport);
  const connection = new Connection(transport, storage, bus);
  const loaded = loadFeatures(features, { bus, ports: { transport, storage, installer, ota, status: system?.status }, api, connection });
  return { connection, loaded, power: system?.power ?? null };
}

/** Real blur only where it's cheap and possible: Android 12+, and not in battery saver. */
function useBlur(power: DevicePower | null): boolean {
  const [saving, setSaving] = useState(() => power?.powerSave() ?? false);
  useEffect(() => power?.onPowerSaveChange(setSaving), [power]);
  return !!power && power.sdkInt >= BLUR_MIN_SDK && !saving;
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
  const blur = useBlur(app.power);
  const glass = useMemo(() => ({ blur }), [blur]);
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <GlassContext.Provider value={glass}>
        <View style={styles.root}>
          <Shell loaded={app.loaded} connection={app.connection} />
        </View>
      </GlassContext.Provider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
