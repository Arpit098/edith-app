// Adapter: OngoingStatus (Live Alerts) and DevicePower on our native module android-modules/edith-system.

import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid } from 'react-native';

import type { DevicePower, OngoingStatus, OngoingStatusView } from '../../../core/ports';

interface NativeSystem {
  sdkInt: number;
  isPowerSaveMode(): boolean;
  showStatus(view: OngoingStatusView): void;
  clearStatus(): void;
  notificationsEnabled(): boolean;
  canPromote(): boolean;
  openPromotionSettings(): void;
  addListener(event: 'onPowerSaveChanged', listener: (e: { on: boolean }) => void): { remove(): void };
}

/** Null where the native module isn't built in (jest, web). */
export function createAndroidSystem(): { status: OngoingStatus; power: DevicePower } | null {
  const native = requireOptionalNativeModule<NativeSystem>('EdithSystem');
  if (!native) return null;
  const sdkInt = Number(native.sdkInt);
  const status: OngoingStatus = {
    show: (view) => native.showStatus(view),
    clear: () => native.clearStatus(),
    async ensurePermission() {
      if (native.notificationsEnabled()) return true;
      if (sdkInt < 33) return false; // turned off by Arpit in system settings: don't nag
      const r = await PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as never);
      return r === PermissionsAndroid.RESULTS.GRANTED;
    },
    canPromote: () => native.canPromote(),
    openPromotionSettings: () => native.openPromotionSettings(),
  };
  const power: DevicePower = {
    sdkInt,
    powerSave: () => native.isPowerSaveMode(),
    onPowerSaveChange(handler) {
      const sub = native.addListener('onPowerSaveChanged', (e) => handler(e.on));
      return () => sub.remove();
    },
  };
  return { status, power };
}
