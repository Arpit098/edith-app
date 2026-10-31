// Live session: EDITH's Claude session as it happens, with text, push-to-talk and attachments, and
// Stop; swipe a message to reply to it. Its status chip sits in the header on every screen.

import type { Connection } from '../../core/connection';
import { localEvent } from '../../core/events';
import { str } from '../../core/guards';
import type { FeatureModule, PanelProps } from '../../core/feature';
import { useStoreOr } from '../../core/store';
import { createStore } from '../../core/store';
import { createAttachmentsModel, type AttachmentsModel } from './attachments';
import { LiveScreen } from './LiveScreen';
import { createLiveModel, type LiveModel } from './model';
import { sendWithReply, type Quote } from './reply';
import { StatusChip, StatusPopup } from './StatusPanel';
import { createVoiceModel, type VoiceModel } from './voice';
import { VoiceSettings } from './VoiceSettings';
import { voiceSummary } from './summary';

let model: LiveModel | null = null;
let voice: VoiceModel | null = null;
let attach: AttachmentsModel | null = null;
let connection: Connection | null = null;
let openSettings: () => void = () => {};
// The composer's menu: open or closed. Closed whenever another screen comes up, so it never stays
// open (and its back handler never eats a back press) behind another screen.
const menu = createStore(false);
// The message being replied to (swipe to reply); dropped when the conversation changes.
const reply = createStore<Quote | null>(null);
// The status card under the header chip; closed when another screen comes up.
const status = createStore(false);

function Screen() {
  return model && voice && attach ? <LiveScreen model={model} voice={voice} attach={attach} menu={menu} reply={reply} /> : null;
}

function Settings() {
  return voice ? <VoiceSettings voice={voice} /> : null;
}

function useVoiceSummary() {
  return useStoreOr(voice?.store, voiceSummary, null);
}

function Chip({ backdrop }: PanelProps) {
  return model && connection ? <StatusChip model={model} connection={connection} open={status} backdrop={backdrop} /> : null;
}

function Popup({ top, backdrop }: PanelProps) {
  return model && connection ? <StatusPopup model={model} connection={connection} open={status} top={top} backdrop={backdrop} onSettings={openSettings} /> : null;
}

const liveSession: FeatureModule = {
  id: 'live-session',
  screens: [{ name: 'live', title: 'Live', component: Screen, tab: true, icon: 'message-text-outline' }],
  settings: [{ title: 'Voice input', component: Settings, group: 'voice', icon: 'microphone-outline', order: 10, summary: useVoiceSummary }],
  panels: [{ slot: 'header', component: Chip, overlay: Popup }],
  setup: ({ bus, api, ports, connection: conn }) => {
    const m = createLiveModel(bus, api, ports.data, ports.visibility);
    // Speech sent by itself (auto-send) answers the quoted message too, as the Send button does.
    const voiceSend = sendWithReply(reply, (text, o: { voice: boolean; replyTo?: Quote | null }) => m.send(text, o));
    const v = createVoiceModel({ bus, send: voiceSend, storage: ports.storage, recorder: ports.recorder, stt: ports.stt });
    const a = createAttachmentsModel({ api, media: ports.media });
    ports.media?.prune(); // old picked files and thumbnails: bounded by age and size
    const offScreen = bus.on(
      'app.screen',
      (e) => {
        if (str(e.data.name) !== 'live') menu.set(false);
        status.set(false);
      },
      'live-session',
    );
    const offSession = bus.on('session.changed', () => reply.set(null), 'live-session');
    model = m;
    voice = v;
    attach = a;
    connection = conn;
    openSettings = () => {
      status.set(false);
      bus.publish(localEvent('app.open', { screen: 'settings', page: 'Server connection' })); // only offered when the token is rejected
    };
    return () => {
      offScreen();
      offSession();
      menu.set(false);
      reply.set(null);
      status.set(false);
      m.dispose();
      v.dispose();
      a.dispose();
      if (model === m) model = null;
      if (voice === v) voice = null;
      if (attach === a) attach = null;
      if (connection === conn) connection = null;
    };
  },
};

export default liveSession;
