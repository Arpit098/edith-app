// Backup AI: while Claude is at its limit and no other account is free, a free AI answers
// read-only (contracts/backup.md). The app shows a pill above every screen while it does; its
// replies arrive as ordinary messages labelled "Backup (Nemotron): …".

import type { FeatureModule } from '../../core/feature';
import { BackupPill } from './BackupPill';
import { createBackupModel, type BackupModel } from './model';

let model: BackupModel | null = null;

function Pill() {
  return model ? <BackupPill model={model} /> : null;
}

const backup: FeatureModule = {
  id: 'backup',
  panels: [{ slot: 'banner', component: Pill }],
  setup: ({ bus, api }) => {
    const m = createBackupModel(bus, api);
    model = m;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default backup;
