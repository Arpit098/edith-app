// Composition root: the only place that picks adapters and wires them to core and the features.

import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createAndroidInstaller } from './adapters/installer/android';
import { createExpoMediaPicker } from './adapters/media/expo';
import { createAndroidRecorder } from './adapters/recorder/android';
import { createAsyncStorage } from './adapters/storage/async-storage';
import { createSecureStorage } from './adapters/storage/secure-store';
import { createServerWhisper } from './adapters/stt/server-whisper';
import { createAndroidSystem } from './adapters/system/android';
import { createExpoOtaUpdates } from './adapters/updates/expo-updates';
import { createEdithApiTransport } from './adapters/transport/edith-api';
import { createAppStateVisibility } from './adapters/visibility/react-native';
import { createApi } from './core/api';
import { Connection } from './core/connection';
import { EventBus } from './core/events';
import { loadFeatures } from './core/feature';
import { features } from './features';
import { Shell } from './shell/Shell';
import { colors } from './ui/theme';

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
  return { connection, loaded };
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
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.root}>
        <Shell loaded={app.loaded} connection={app.connection} />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
});
