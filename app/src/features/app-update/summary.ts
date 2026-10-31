// The Settings row's line for Updates: what's happening now, else whether this build is the newest.

import { apkAvailable, type AppUpdateState } from './model';

export function updateSummary(s: AppUpdateState): string | null {
  const build = s.installed ? `build ${s.installed.versionCode}` : null;
  if (s.phase === 'downloading') return s.total ? `Downloading · ${Math.floor((s.received / s.total) * 100)} %` : 'Downloading…';
  if (s.phase === 'installing') return 'Installing…';
  if (s.checking) return 'Checking…';
  if (apkAvailable(s)) return `Update available · build ${s.latest!.versionCode}`;
  if (s.otaReady) return 'Update ready · used on the next start';
  if (s.error) return 'Couldn’t check for updates';
  if (s.checkedAt !== null) return build ? `Up to date · ${build}` : 'Up to date';
  return build ? `Build ${s.installed!.versionCode}` : null;
}
