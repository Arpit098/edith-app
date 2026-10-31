// Live session: EDITH's Claude session as it happens, with text, push-to-talk and attachments, and Stop.

import { str } from '../../core/guards';
import type { FeatureModule } from '../../core/feature';
import { createStore } from '../../core/store';
import { createAttachmentsModel, type AttachmentsModel } from './attachments';
import { LiveScreen } from './LiveScreen';
import { createLiveModel, type LiveModel } from './model';
import { createVoiceModel, type VoiceModel } from './voice';
import { VoiceSettings } from './VoiceSettings';

let model: LiveModel | null = null;
let voice: VoiceModel | null = null;
let attach: AttachmentsModel | null = null;
// The composer's menu: open or closed. Closed whenever another screen comes up, so it never stays
// open (and its back handler never eats a back press) behind another screen.
const menu = createStore(false);

function Screen() {
  return model && voice && attach ? <LiveScreen model={model} voice={voice} attach={attach} menu={menu} /> : null;
}

function Settings() {
  return voice ? <VoiceSettings voice={voice} /> : null;
}

const liveSession: FeatureModule = {
  id: 'live-session',
  screens: [{ name: 'live', title: 'Live', component: Screen, tab: true, icon: 'message-text-outline' }],
  settings: [{ title: 'Voice input', component: Settings }],
  setup: ({ bus, api, ports }) => {
    const m = createLiveModel(bus, api, ports.data, ports.visibility);
    const v = createVoiceModel({ bus, send: (text, o) => m.send(text, o), storage: ports.storage, recorder: ports.recorder, stt: ports.stt });
    const a = createAttachmentsModel({ api, media: ports.media });
    ports.media?.prune(); // old picked files and thumbnails: bounded by age and size
    const offScreen = bus.on(
      'app.screen',
      (e) => {
        if (str(e.data.name) !== 'live') menu.set(false);
      },
      'live-session',
    );
    model = m;
    voice = v;
    attach = a;
    return () => {
      offScreen();
      menu.set(false);
      m.dispose();
      v.dispose();
      a.dispose();
      if (model === m) model = null;
      if (voice === v) voice = null;
      if (attach === a) attach = null;
    };
  },
};

export default liveSession;
