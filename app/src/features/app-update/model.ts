// App updates (contracts/app-updates.md): OTA JS bundles through the OtaUpdates port, and new APKs
// from edith: GET /v1/app/latest → download (SHA-256 checked natively) → Android's installer.

import { backoffDelay, sleep as wait, type Backoff } from '../../common/backoff';
import { isRetryable, type Api, type AppRelease } from '../../core/api';
import type { EventBus } from '../../core/events';
import type { AppInstaller, InstallStatus, OtaInfo, OtaUpdates, Transport } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

export const AUTO_CHECK_EVERY_S = 6 * 3600; // automatic checks on connect, at most this often
export const DOWNLOAD_ATTEMPTS = 3; // a failed download resumes from where it stopped
const DOWNLOAD_BACKOFF: Backoff = { baseMs: 2000, maxMs: 15_000 };
const CHANNEL = 'main';

export type Phase = 'idle' | 'needs-permission' | 'downloading' | 'installing' | 'failed';

export interface AppUpdateState {
  installed: { versionName: string; versionCode: number } | null; // null without the native module
  ota: OtaInfo | null; // null without expo-updates
  latest: AppRelease | null;
  checkedAt: number | null; // unix seconds
  checking: boolean;
  error: string | null; // the last check's problem
  otaReady: boolean; // a newer JS bundle is downloaded; used on the next start
  phase: Phase;
  received: number;
  total: number;
  message: string | null; // what the APK install is doing, or why it stopped
}

export interface NoteSections {
  sections: { title: string; items: string[] }[]; // New, Fixes, Changes: only the non-empty ones
  details: string[]; // "Technical details", shown collapsed
}

/** A release's notes for the update screen. Builds from before release notes only have commit
 *  subjects (the plain `notes` text): those go under the technical details. */
export function noteSections(r: AppRelease): NoteSections {
  const n = r.release_notes;
  const sections = n
    ? [
        { title: 'New', items: n.new },
        { title: 'Fixes', items: n.fixes },
        { title: 'Changes', items: n.changes },
      ].filter((s) => s.items.length > 0)
    : [];
  const details = n && sections.length ? n.details : r.notes.split('\n').map((l) => l.trim()).filter(Boolean);
  return { sections, details };
}

export function apkAvailable(s: AppUpdateState): boolean {
  return !!(s.latest && s.installed && s.latest.versionCode > s.installed.versionCode);
}

export interface AppUpdateDeps {
  bus: EventBus;
  api: Api;
  transport: Transport;
  installer?: AppInstaller;
  ota?: OtaUpdates;
  notify: (text: string) => void;
  now?: () => number; // unix seconds
  sleep?: (ms: number) => Promise<void>;
  random?: () => number; // backoff jitter
}

export interface AppUpdateModel {
  store: Store<AppUpdateState>;
  /** Check edith for a new APK and a new JS bundle. */
  check(): Promise<void>;
  /** Download, verify and hand the new APK to Android's installer. */
  install(): Promise<void>;
  /** Open Android's "Install unknown apps" for EDITH. */
  allowInstalls(): Promise<void>;
  /** Restart now on the downloaded JS bundle. */
  applyOta(): Promise<void>;
  dispose(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const STATUS_TEXT: Record<InstallStatus, { phase: Phase; text: string }> = {
  pending: { phase: 'installing', text: 'Confirm in Android’s installer' },
  success: { phase: 'idle', text: 'Installed' },
  cancelled: { phase: 'idle', text: 'Install cancelled' },
  incompatible: {
    phase: 'failed',
    text: 'Android refused it: the new APK is signed with a different key. Uninstall EDITH once, then install it again (docs/PHASE3_APP_PLAN.md §9c).',
  },
  failed: { phase: 'failed', text: 'Android couldn’t install it' },
};

export function createAppUpdateModel(deps: AppUpdateDeps): AppUpdateModel {
  const { bus, api, transport, installer, ota } = deps;
  const now = deps.now ?? (() => Date.now() / 1000);
  const sleep = deps.sleep ?? wait;
  const store = createStore<AppUpdateState>({
    installed: installer ? { versionName: installer.versionName, versionCode: installer.versionCode } : null,
    ota: ota ? ota.info() : null,
    latest: null,
    checkedAt: null,
    checking: false,
    error: null,
    otaReady: false,
    phase: 'idle',
    received: 0,
    total: 0,
    message: null,
  });
  let notifiedFor = 0; // the versionCode we already told Arpit about

  async function check(manual: boolean) {
    if (store.get().checking) return;
    store.set((s) => ({ ...s, checking: true, error: null }));
    const problems: string[] = [];
    const [latest, otaReady] = await Promise.all([
      api.appLatest().catch((e: unknown) => {
        problems.push(`App: ${message(e)}`);
        return store.get().latest; // keep what we knew
      }),
      ota && ota.info().enabled
        ? ota.fetchUpdate().catch((e: unknown) => {
            // The first launch after a new token still sends the placeholder header (contract §1).
            const text = /401|unauthori/i.test(message(e)) ? 'not signed in yet; works after the next app start' : message(e);
            problems.push(`Code update: ${text}`);
            return false;
          })
        : Promise.resolve(false),
    ]);
    store.set((s) => ({
      ...s,
      latest,
      otaReady: s.otaReady || otaReady,
      checking: false,
      checkedAt: now(),
      error: problems.length ? problems.join(' · ') : null,
    }));
    const s = store.get();
    if (apkAvailable(s) && s.latest!.versionCode !== notifiedFor) {
      notifiedFor = s.latest!.versionCode;
      if (!manual) deps.notify(`EDITH ${s.latest!.versionName} is available: Settings → Update`);
    }
  }

  const offStatus = installer?.onStatus((status, text) => {
    const { phase, text: label } = STATUS_TEXT[status];
    store.set((s) => ({ ...s, phase, message: text && phase === 'failed' ? `${label} (${text})` : label }));
  });

  const offs = [
    bus.on(
      'app.connected',
      () => {
        if (ota) {
          const auth = transport.authorized('/v1/updates/manifest');
          if (auth) ota.setRequestHeaders({ ...auth.headers, 'expo-channel-name': CHANNEL });
        }
        const last = store.get().checkedAt;
        if (last === null || now() - last >= AUTO_CHECK_EVERY_S) void check(false);
      },
      'app-update',
    ),
  ];

  return {
    store,
    check: () => check(true),
    async install() {
      const s = store.get();
      if (!installer || !apkAvailable(s) || s.phase === 'downloading' || s.phase === 'installing') return;
      const latest = s.latest!;
      if (!(await installer.canInstall())) {
        store.set((x) => ({ ...x, phase: 'needs-permission', message: 'Allow EDITH to install apps, then tap Update again' }));
        return;
      }
      const request = transport.authorized(latest.url);
      if (!request) {
        store.set((x) => ({ ...x, phase: 'failed', message: 'Not connected to edith' }));
        return;
      }
      store.set((x) => ({ ...x, phase: 'downloading', received: 0, total: latest.size, message: null }));
      let path: string | null = null;
      for (let attempt = 0; path === null; attempt++) {
        try {
          ({ path } = await installer.download(request, latest.sha256, latest.size, (received, total) =>
            store.set((x) => ({ ...x, received, total: total || x.total })),
          ));
        } catch (e) {
          // Only a network error or a 502/503/504 is worth another try (the partial file resumes).
          // Anything else, such as a 404 or a SHA-256 mismatch, won't get better by retrying.
          if (!isRetryable(e) || attempt + 1 >= DOWNLOAD_ATTEMPTS) {
            const mismatch = /SHA256|sha-256/i.test(message(e));
            store.set((x) => ({ ...x, phase: 'failed', message: mismatch ? 'The download didn’t match its SHA-256 and was deleted' : `Download failed: ${message(e)}` }));
            return;
          }
          await sleep(backoffDelay(attempt, DOWNLOAD_BACKOFF, deps.random));
        }
      }
      store.set((x) => ({ ...x, phase: 'installing', message: 'Opening Android’s installer…' }));
      try {
        await installer.install(path);
      } catch (e) {
        store.set((x) => ({ ...x, phase: 'failed', message: `Couldn’t start the installer: ${message(e)}` }));
      }
    },
    async allowInstalls() {
      await installer?.openInstallSettings();
      store.set((x) => (x.phase === 'needs-permission' ? { ...x, phase: 'idle', message: null } : x));
    },
    async applyOta() {
      await ota?.reload();
    },
    dispose() {
      offStatus?.();
      offs.forEach((off) => off());
    },
  };
}
