// Adapter: OngoingStatus (Live Alerts), Notifier and PushReceiver on our native module android-modules/edith-system.

import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid } from 'react-native';

import type { LocalNotification, Notifier, OngoingStatus, OngoingStatusView, PushMode, PushReceiver, PushSetup, PushStatus } from '../../../core/ports';

interface NativeSystem {
  sdkInt: number;
  showStatus(view: OngoingStatusView): void;
  clearStatus(): void;
  notify(json: string): void;
  cancel(tag: string): void;
  activeTags(): string[];
  notificationsEnabled(): boolean;
  canPromote(): boolean;
  openPromotionSettings(): void;
  testIsland(): { ok: boolean; message: string };
  pushEnable(setup: PushSetup): boolean;
  pushUpdateApi(apiUrl: string, apiToken: string): void;
  pushSetMode(mode: PushMode): boolean;
  pushResume(): boolean;
  pushDisable(): void;
  pushStatus(): Partial<PushStatus>;
  openBatterySettings(): void;
}

const MIN_SDK = 26; // notification channels and foreground-service starts (Android 8); the app's minSdk is 24

/** Null where the native module isn't built in (jest, web), or on Android older than 8. */
export function createAndroidSystem(): { status: OngoingStatus; notifier: Notifier; push: PushReceiver } | null {
  const native = requireOptionalNativeModule<NativeSystem>('EdithSystem');
  if (!native) return null;
  const sdkInt = Number(native.sdkInt);
  if (sdkInt < MIN_SDK) return null;
  // One question for both ports: two features asking at once must not stack two dialogs.
  let asking: Promise<boolean> | null = null;
  const ensurePermission = (): Promise<boolean> => {
    if (native.notificationsEnabled()) return Promise.resolve(true);
    if (sdkInt < 33) return Promise.resolve(false); // turned off by Arpit in system settings: don't nag
    asking ??= PermissionsAndroid.request('android.permission.POST_NOTIFICATIONS' as never)
      .then((r) => r === PermissionsAndroid.RESULTS.GRANTED)
      .finally(() => {
        asking = null;
      });
    return asking;
  };
  const status: OngoingStatus = {
    show: (view) => native.showStatus(view),
    clear: () => native.clearStatus(),
    ensurePermission,
    canPromote: () => native.canPromote(),
    openPromotionSettings: () => native.openPromotionSettings(),
    liveUpdates: sdkInt >= 36, // Android 16
    testIsland: () => native.testIsland(),
  };
  const notifier: Notifier = {
    // JSON, not a record: the native side keeps it in the action buttons to redraw the notification.
    post: (n: LocalNotification) => native.notify(JSON.stringify(n)),
    cancel: (tag) => native.cancel(tag),
    active: async () => native.activeTags(),
    ensurePermission,
  };
  const push: PushReceiver = {
    enable: (setup) => native.pushEnable(setup),
    updateApi: (apiUrl, apiToken) => native.pushUpdateApi(apiUrl, apiToken),
    setMode: (mode) => native.pushSetMode(mode),
    resume: () => native.pushResume(),
    disable: () => native.pushDisable(),
    status: () => {
      const s = native.pushStatus();
      return {
        enabled: s.enabled === true,
        ntfyUrl: s.ntfyUrl ?? null,
        mode: s.mode === 'poll' ? 'poll' : 'instant',
        connected: s.connected === true,
        error: s.error ?? null,
        lastCheckAt: typeof s.lastCheckAt === 'number' ? s.lastCheckAt : null,
        batteryUnrestricted: s.batteryUnrestricted === true,
      };
    },
    openBatterySettings: () => native.openBatterySettings(),
  };
  return { status, notifier, push };
}
