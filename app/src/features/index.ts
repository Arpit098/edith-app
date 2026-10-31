// The enabled features, in tab order. Adding or removing a feature is one line here.
// The shell adds its own Tools (the grid of features' `tool` tiles) and Settings tabs after these.

import type { FeatureModule } from '../core/feature';
import appUpdate from './app-update';
import approvals from './approvals';
import claudeAccounts from './claude-accounts';
import commands from './commands';
import liveSession from './live-session';
import liveStatus from './live-status';
import notifications from './notifications';
import push from './push';
import sessions from './sessions';
import wakeword from './wakeword';

export const features: FeatureModule[] = [
  liveSession,
  sessions,
  approvals,
  commands,
  appUpdate,
  claudeAccounts,
  liveStatus,
  notifications,
  push, // Phase 5: pushes with the app closed (ntfy)
  // Phase 3: voice, assistant, widget
  wakeword, // Phase 4: training and settings now; the detector later
];
