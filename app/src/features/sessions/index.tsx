// Sessions: EDITH's recent conversations; switch, rename, or start a new one.

import type { FeatureModule } from '../../core/feature';
import { toast } from '../../ui/toast';
import { createSessionsModel, type SessionsModel } from './model';
import { SessionsScreen } from './SessionsScreen';

let model: SessionsModel | null = null;

function Screen() {
  return model ? <SessionsScreen model={model} /> : null;
}

const sessions: FeatureModule = {
  id: 'sessions',
  screens: [{ name: 'sessions', title: 'Sessions', component: Screen, tab: true, icon: 'history' }],
  setup: ({ bus, api }) => {
    const m = createSessionsModel(bus, api, toast);
    model = m;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default sessions;
