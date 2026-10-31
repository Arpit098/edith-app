// Adapter: the OtaUpdates port on expo-updates, pointed at edith's App API (contracts/app-updates.md).

import * as Updates from 'expo-updates';

import type { OtaUpdates } from '../../../core/ports';

export function createExpoOtaUpdates(): OtaUpdates {
  return {
    info: () => ({
      enabled: Updates.isEnabled,
      updateId: Updates.updateId,
      createdAt: Updates.createdAt ? Updates.createdAt.getTime() / 1000 : null,
      embedded: Updates.isEmbeddedLaunch,
      rolledBack: Updates.isEmergencyLaunch,
      runtimeVersion: Updates.runtimeVersion,
    }),
    setRequestHeaders(headers) {
      if (Updates.isEnabled) Updates.setUpdateRequestHeadersOverride(headers);
    },
    async fetchUpdate() {
      if (!Updates.isEnabled) return null;
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) return null;
      const fetched = await Updates.fetchUpdateAsync();
      if (!fetched.isNew) return null;
      // The downloaded bundle's id keys the update banner, so a later bundle shows it again.
      const id = (fetched.manifest as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' && id ? id : 'downloaded';
    },
    reload: () => Updates.reloadAsync(),
  };
}
