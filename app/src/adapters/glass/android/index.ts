// Adapter: DevicePower, FrameMeter and the native glass view, on our module android-modules/edith-glass.

import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';

import type { DevicePower, FrameMeter, FrameReport } from '../../../core/ports';
import type { NativeGlassProps } from '../../../core/theme';

interface NativeGlass {
  sdkInt: number;
  isPowerSaveMode(): boolean;
  startFrameStats(): void;
  stopFrameStats(): Promise<FrameReport | null>;
  addListener(event: 'onPowerSaveChanged', listener: (e: { on: boolean }) => void): { remove(): void };
}

export interface AndroidGlass {
  power: DevicePower;
  meter: FrameMeter;
  View: ComponentType<NativeGlassProps>;
}

/** Null where the native module isn't built in (jest, web): glass stays flat there. */
export function createAndroidGlass(): AndroidGlass | null {
  const native = requireOptionalNativeModule<NativeGlass>('EdithGlass');
  if (!native) return null;
  return {
    power: {
      sdkInt: Number(native.sdkInt),
      powerSave: () => native.isPowerSaveMode(),
      onPowerSaveChange(handler) {
        const sub = native.addListener('onPowerSaveChanged', (e) => handler(e.on));
        return () => sub.remove();
      },
    },
    meter: {
      start: () => native.startFrameStats(),
      stop: () => native.stopFrameStats(),
    },
    View: requireNativeView<NativeGlassProps>('EdithGlass', 'EdithGlassView'),
  };
}
