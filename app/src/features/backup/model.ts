// The backup AI's state (contracts/backup.md): kept from backup.changed, resynced from GET /v1/backup
// on every connect. Never polled.

import { backupFrom, type Api, type BackupState } from '../../core/api';
import type { EventBus } from '../../core/events';
import { createStore, type Store } from '../../core/store';
import { clockIST } from '../../common/format';

export interface BackupModel {
  store: Store<BackupState | null>;
  dispose(): void;
}

export function createBackupModel(bus: EventBus, api: Api): BackupModel {
  const store = createStore<BackupState | null>(null);
  let sync = 0; // a newer resync or event wins over an older answer still in flight
  const offs = [
    bus.on(
      'backup.changed',
      (e) => {
        sync++;
        store.set(backupFrom(e.data));
      },
      'backup',
    ),
    bus.on(
      'app.connected',
      () => {
        const mine = ++sync;
        api.backup().then(
          (b) => {
            if (mine === sync) store.set(b);
          },
          () => {}, // an older server without the backup feature: nothing to show
        );
      },
      'backup',
    ),
  ];
  return { store, dispose: () => offs.forEach((off) => off()) };
}

/** The pill's line while the backup answers, or null when Claude does. */
export function pillText(b: BackupState | null): string | null {
  if (!b || !b.active) return null;
  const who = b.provider ? `Backup AI (${b.provider})` : 'Backup AI';
  const until = b.reason === 'manual' ? ' · turned on with /backup on' : b.resets ? ` · Claude back ~${clockIST(b.resets)} IST` : '';
  const queued = b.queued ? ` · ${b.queued} queued for Claude` : '';
  return `${who} is answering, read-only${until}${queued}`;
}
