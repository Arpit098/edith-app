// Live session: EDITH's Claude session as it happens, with text, push-to-talk and attachments, and
// Stop; swipe a message to reply to it. Its status chip sits in the header on every screen.
// edith://live/type, /listen and /attach (the home-screen EDITH bar) open it ready to type, already
// listening, or with the attach menu open (./launch).

import type { Connection } from '../../core/connection';
import { localEvent } from '../../core/events';
import { str } from '../../core/guards';
import type { FeatureModule, PanelProps } from '../../core/feature';
import { useStoreOr } from '../../core/store';
import { createStore } from '../../core/store';
import { createAttachmentsModel, type AttachmentsModel } from './attachments';
import { createLaunch } from './launch';
import { LiveScreen } from './LiveScreen';
import { createLiveModel, type LiveModel } from './model';
import { createReceivedModel, type ReceivedModel } from './received';
import { sendWithReply, type Quote } from './reply';
import { StatusChip, StatusPopup } from './StatusPanel';
import { createVoiceModel, type VoiceModel } from './voice';
import { VoiceSettings } from './VoiceSettings';
import { voiceSummary } from './summary';
import { ChatSettings, chatSummary } from './ChatSettings';
import { createWorkDetailSetting, type WorkDetailSetting } from './chatSettings';
import { WORK_DETAILS } from './work';

let model: LiveModel | null = null;
let voice: VoiceModel | null = null;
let attach: AttachmentsModel | null = null;
let received: ReceivedModel | null = null;
let connection: Connection | null = null;
let openSettings: () => void = () => {};
// The composer's menu: open or closed. Closed whenever another screen comes up, so it never stays
// open (and its back handler never eats a back press) behind another screen.
const menu = createStore(false);
// The message being replied to (swipe to reply); dropped when the conversation changes.
const reply = createStore<Quote | null>(null);
// The status card under the header chip; closed when another screen comes up.
const status = createStore(false);

// A link asked for the message box (edith://live/type): the composer focuses it once drawn.
const focus = createStore(false);
// A light tick as a swipe catches a message to reply to (ports.haptics; none in tests and on web).
let haptic: (() => void) | undefined;

// Settings → Chat → Work details (how much each turn's Work card shows).
let workDetail: WorkDetailSetting | null = null;

function Screen() {
  return model && voice && attach ? <LiveScreen model={model} voice={voice} attach={attach} received={received} menu={menu} reply={reply} focus={focus} haptic={haptic} workDetail={workDetail?.store} /> : null;
}

function Settings() {
  return voice ? <VoiceSettings voice={voice} /> : null;
}

function useVoiceSummary() {
  return useStoreOr(voice?.store, voiceSummary, null);
}

function Chat() {
  return workDetail ? <ChatSettings setting={workDetail} /> : null;
}

function useChatSummary() {
  const id = useStoreOr(workDetail?.store, (d) => d, null);
  return chatSummary(WORK_DETAILS.find((d) => d.id === id)?.name);
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
  settings: [
    { title: 'Voice input', component: Settings, group: 'voice', icon: 'microphone-outline', order: 10, summary: useVoiceSummary },
    { title: 'Chat', component: Chat, group: 'app', icon: 'message-cog-outline', order: 8, summary: useChatSummary },
  ],
  panels: [{ slot: 'header', component: Chip, overlay: Popup }],
  setup: ({ bus, api, ports, connection: conn }) => {
    const m = createLiveModel(bus, api, ports.data, ports.visibility);
    // Speech sent by itself (auto-send) answers the quoted message too, as the Send button does.
    const voiceSend = sendWithReply(reply, (text, o: { voice: boolean; replyTo?: Quote | null }) => m.send(text, o));
    const v = createVoiceModel({ bus, send: voiceSend, storage: ports.storage, recorder: ports.recorder, stt: ports.stt });
    const a = createAttachmentsModel({ api, media: ports.media });
    ports.media?.prune(); // old picked files and thumbnails: bounded by age and size
    const r = createReceivedModel({ transport: ports.transport, files: ports.files });
    ports.files?.prune(); // old downloads of files EDITH sent: bounded by age and size
    const w = createWorkDetailSetting(ports.data);
    void w.load();
    workDetail = w;
    const offScreen = bus.on(
      'app.screen',
      (e) => {
        if (str(e.data.name) !== 'live') menu.set(false);
        status.set(false);
      },
      'live-session',
    );
    const offSession = bus.on('session.changed', () => reply.set(null), 'live-session');
    const launch = createLaunch({ voice: v, menu, focus });
    const offLink = bus.on('app.link', (e) => str(e.data.screen) === 'live' && launch(str(e.data.action), e.data.trusted === true), 'live-session');
    const haptics = ports.haptics;
    const tick = haptics ? () => haptics.tick() : undefined;
    haptic = tick;
    model = m;
    voice = v;
    attach = a;
    received = r;
    connection = conn;
    openSettings = () => {
      status.set(false);
      bus.publish(localEvent('app.open', { screen: 'settings', page: 'Server connection' })); // only offered when the token is rejected
    };
    return () => {
      offScreen();
      offSession();
      offLink();
      menu.set(false);
      focus.set(false);
      if (haptic === tick) haptic = undefined;
      reply.set(null);
      status.set(false);
      m.dispose();
      v.dispose();
      a.dispose();
      r.dispose();
      if (model === m) model = null;
      if (voice === v) voice = null;
      if (attach === a) attach = null;
      if (received === r) received = null;
      if (connection === conn) connection = null;
      if (workDetail === w) workDetail = null;
    };
  },
};

export default liveSession;
