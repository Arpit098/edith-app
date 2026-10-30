// Adapter: DevicePower from React Native alone (the Android version). Battery saver isn't visible
// from JS; the native glass module (Phase 2b, next step) replaces this with PowerManager's
// isPowerSaveMode and its change broadcast.

import { Platform } from 'react-native';

import type { DevicePower } from '../../../core/ports';

/** Null off Android (jest, web): glass stays flat there. */
export function createAndroidPower(): DevicePower | null {
  if (Platform.OS !== 'android') return null;
  return {
    sdkInt: typeof Platform.Version === 'number' ? Platform.Version : Number(Platform.Version),
    powerSave: () => false,
    onPowerSaveChange: () => () => {},
  };
}
