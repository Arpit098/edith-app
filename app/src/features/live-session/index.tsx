// Live session: EDITH's Claude session as it happens, with text and push-to-talk send, and Stop.

import type { FeatureModule } from '../../core/feature';
import { LiveScreen } from './LiveScreen';
import { createLiveModel, type LiveModel } from './model';
import { createVoiceModel, type VoiceModel } from './voice';
import { VoiceSettings } from './VoiceSettings';

let model: LiveModel | null = null;
let voice: VoiceModel | null = null;

function Screen() {
  return model && voice ? <LiveScreen model={model} voice={voice} /> : null;
}

function Settings() {
  return voice ? <VoiceSettings voice={voice} /> : null;
}

const liveSession: FeatureModule = {
  id: 'live-session',
  screens: [{ name: 'live', title: 'Live', component: Screen, tab: true, icon: 'message-text-outline' }],
  settings: [{ title: 'Voice input', component: Settings }],
  setup: ({ bus, api, ports }) => {
    const m = createLiveModel(bus, api);
    const v = createVoiceModel({ bus, api, storage: ports.storage, recorder: ports.recorder, stt: ports.stt });
    model = m;
    voice = v;
    return () => {
      m.dispose();
      v.dispose();
      if (model === m) model = null;
      if (voice === v) voice = null;
    };
  },
};

export default liveSession;
