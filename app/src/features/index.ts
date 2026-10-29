// The enabled features, in tab order. Adding or removing a feature is one line here.
// The shell adds its own Tools (the grid of features' `tool` tiles) and Settings tabs after these.

import type { FeatureModule } from '../core/feature';
import approvals from './approvals';
import commands from './commands';
import liveSession from './live-session';
import sessions from './sessions';

export const features: FeatureModule[] = [
  liveSession,
  sessions,
  approvals,
  commands,
  // Phase 3: voice, assistant, widget
  // Phase 4: wakeword
];
