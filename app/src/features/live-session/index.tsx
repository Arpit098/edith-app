// Live session: EDITH's Claude session as it happens, with text send and Stop.

import type { FeatureModule } from '../../core/feature';
import { LiveScreen } from './LiveScreen';
import { createLiveModel, type LiveModel } from './model';

let model: LiveModel | null = null;

function Screen() {
  return model ? <LiveScreen model={model} /> : null;
}

const liveSession: FeatureModule = {
  id: 'live-session',
  screens: [{ name: 'live', title: 'Live', component: Screen, tab: true, icon: 'message-text-outline' }],
  setup: ({ bus, api }) => {
    const m = createLiveModel(bus, api);
    model = m;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default liveSession;
