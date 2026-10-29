// Adapter: the AppInstaller port on our native module (android-modules/edith-installer).

import { requireOptionalNativeModule } from 'expo';

import type { AppInstaller, InstallStatus } from '../../../core/ports';

interface Subscription {
  remove(): void;
}

interface NativeInstaller {
  versionName: string;
  versionCode: number;
  download(url: string, headers: Record<string, string>, sha256: string, size: number): Promise<{ path: string; sha256: string; size: number }>;
  canInstall(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  install(path: string): Promise<number>;
  clearDownloads(): Promise<void>;
  addListener(event: 'onProgress', listener: (e: { received: number; total: number }) => void): Subscription;
  addListener(event: 'onInstallStatus', listener: (e: { status: InstallStatus; message: string }) => void): Subscription;
}

/** Null where the native module isn't built in (jest, web, an APK from before it existed). */
export function createAndroidInstaller(): AppInstaller | null {
  const native = requireOptionalNativeModule<NativeInstaller>('EdithInstaller');
  if (!native) return null;
  return {
    versionName: native.versionName,
    versionCode: Number(native.versionCode),
    async download(request, sha256, size, onProgress) {
      const sub = native.addListener('onProgress', (e) => onProgress(e.received, e.total));
      try {
        const r = await native.download(request.url, request.headers, sha256, size);
        return { path: r.path };
      } finally {
        sub.remove();
      }
    },
    canInstall: () => native.canInstall(),
    openInstallSettings: () => native.openInstallSettings(),
    async install(path) {
      await native.install(path);
    },
    onStatus(handler) {
      const sub = native.addListener('onInstallStatus', (e) => handler(e.status, e.message));
      return () => sub.remove();
    },
    clearDownloads: () => native.clearDownloads(),
  };
}
