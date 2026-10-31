// App updates (contracts/app-updates.md): OTA JS bundles through the OtaUpdates port, and new APKs
// from edith: GET /v1/app/latest → download (SHA-256 checked natively) → Android's installer.

import { backoffDelay, sleep as wait, type Backoff } from '../../common/backoff';
import { isRetryable, type Api, type AppRelease } from '../../core/api';
import type { EventBus } from '../../core/events';
import type { AppInstaller, AppVisibility, InstallStatus, KeyValueStore, OtaInfo, OtaUpdates, Transport } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

export const AUTO_CHECK_EVERY_S = 6 * 3600; // automatic checks on connect, at most this often
export const FOREGROUND_CHECK_S = 3600; // back in the foreground: check if the last check is older than this
export const OPENED_CHECK_S = 60; // Settings → Updates opened (e.g. from the push): check unless just checked
export const SEEN_KEY = 'app-update.seen'; // the last update the banner (or Settings → Updates) showed
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
  otaId: string | null; // that bundle's update id (the banner's key), when known
  phase: Phase;
  received: number;
  total: number;
  message: string | null; // what the APK install is doing, or why it stopped
  seen: string | null; // bannerKey() of the last update Arpit saw (banner dismissed, or Updates opened)
  seenLoaded: boolean; // `seen` read from the phone: no banner before, so a seen one never flashes
  restarting: boolean; // "Restart to update": downloading the code update, then reloading
}

export interface UpdateBanner {
  key: string;
  text: string;
  action: 'restart' | 'open'; // restart on the code update; open Settings → Updates (an APK to install)
}

/** What the update banner is about: a downloaded code update (for the running bundle), else a newer APK. */
export function bannerKey(s: AppUpdateState): string | null {
  if (s.otaReady) return `ota:${s.otaId ?? s.ota?.updateId ?? 'embedded'}`;
  if (apkAvailable(s)) return `apk:${s.latest!.versionCode}`;
  return null;
}

/** The in-app banner (the fallback when push is off): an update not seen yet, unless one is underway. */
export function updateBanner(s: AppUpdateState): UpdateBanner | null {
  const key = bannerKey(s);
  if (!key || !s.seenLoaded || key === s.seen || s.phase === 'downloading' || s.phase === 'installing') return null;
  if (s.otaReady) return { key, text: 'Update ready · Restart', action: 'restart' };
  return { key, text: `EDITH ${s.latest!.versionName} available · Install`, action: 'open' };
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
  data?: KeyValueStore; // remembers the update the banner last showed
  visibility?: AppVisibility; // a check when EDITH comes back to the foreground
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
  /** "Restart to update": download the code update if it isn't yet, then restart on it. */
  restartToUpdate(): Promise<void>;
  /** The banner's update was seen (dismissed or acted on): it isn't shown again. */
  markSeen(): void;
  /** Settings → Updates is open: what it shows counts as seen; checks unless it just did. */
  opened(): void;
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
    otaId: null,
    phase: 'idle',
    received: 0,
    total: 0,
    message: null,
    seen: null,
    seenLoaded: !deps.data,
    restarting: false,
  });
  if (deps.data) {
    deps.data.get(SEEN_KEY).then(
      (seen) => store.set((s) => ({ ...s, seen: s.seen ?? seen, seenLoaded: true })),
      () => store.set((s) => ({ ...s, seenLoaded: true })),
    );
  }
  let notifiedFor = 0; // the versionCode we already told Arpit about

  let recheck = false; // edith announced an update during a check: one more check after it

  async function check(manual: boolean) {
    if (store.get().checking) return;
    try {
      await checkOnce(manual);
    } finally {
      if (recheck) {
        recheck = false;
        void check(false);
      }
    }
  }

  async function checkOnce(manual: boolean) {
    store.set((s) => ({ ...s, checking: true, error: null }));
    const problems: string[] = [];
    const [latest, otaId] = await Promise.all([
      api.appLatest().catch((e: unknown) => {
        problems.push(`App: ${message(e)}`);
        return store.get().latest; // keep what we knew
      }),
      ota && ota.info().enabled
        ? ota.fetchUpdate().catch((e: unknown) => {
            // The first launch after a new token still sends the placeholder header (contract §1).
            const text = /401|unauthori/i.test(message(e)) ? 'not signed in yet; works after the next app start' : message(e);
            problems.push(`Code update: ${text}`);
            return null;
          })
        : Promise.resolve(null),
    ]);
    store.set((s) => ({
      ...s,
      latest,
      otaReady: s.otaReady || otaId !== null,
      otaId: otaId ?? s.otaId,
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

  function markSeen() {
    const key = bannerKey(store.get());
    if (!key || store.get().seen === key) return;
    store.set((s) => ({ ...s, seen: key }));
    deps.data?.set(SEEN_KEY, key).catch(() => {});
  }

  const stale = (seconds: number) => {
    const last = store.get().checkedAt;
    return last === null || now() - last >= seconds;
  };

  const offs = [
    // edith announced a new update (contracts/app-updates.md §7): fetch it now, so the banner can offer it.
    bus.on(
      'app.update_available',
      () => {
        if (store.get().checking) recheck = true; // this check may have asked edith before the update came
        else void check(false);
      },
      'app-update',
    ),
    ...(deps.visibility
      ? [
          deps.visibility.onChange((active) => {
            if (active && stale(FOREGROUND_CHECK_S)) void check(false);
          }),
        ]
      : []),
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
    async restartToUpdate() {
      if (!ota || store.get().restarting) return;
      store.set((s) => ({ ...s, restarting: true }));
      try {
        const id = store.get().otaReady ? store.get().otaId : await ota.fetchUpdate();
        if (store.get().otaReady || id !== null) {
          store.set((s) => ({ ...s, otaReady: true, otaId: id ?? s.otaId }));
          markSeen();
          await ota.reload();
          return;
        }
        deps.notify('No code update to restart on');
      } catch (e) {
        deps.notify(`Couldn’t get the update: ${message(e)}`);
      } finally {
        store.set((s) => ({ ...s, restarting: false }));
      }
    },
    markSeen,
    opened() {
      markSeen();
      if (stale(OPENED_CHECK_S)) void check(false).then(markSeen);
    },
    dispose() {
      offStatus?.();
      offs.forEach((off) => off());
    },
  };
}
