// Wake word: the "Train wake word" screen (record and upload "Hey Edith" and home noise for the model
// trained on Arpit's Mac, PLAN.md §4.5) and its Settings section. The always-on detector
// (WakeWordService) comes later, behind ports.wakeWord.

import type { EventBus } from '../../core/events';
import type { FeatureModule } from '../../core/feature';
import { useStoreOr } from '../../core/store';
import { createWakewordModel, type WakewordModel } from './model';
import { TrainScreen } from './TrainScreen';
import { WakeWordSettings } from './WakeWordSettings';
import { wakewordSummary } from './summary';

let model: WakewordModel | null = null;
let bus: EventBus | null = null;

function Screen() {
  return model ? <TrainScreen model={model} /> : null;
}

function Settings() {
  return model && bus ? <WakeWordSettings model={model} bus={bus} /> : null;
}

function useSummary() {
  return useStoreOr(model?.store, wakewordSummary, null);
}

const wakeword: FeatureModule = {
  id: 'wakeword',
  screens: [{ name: 'wakeword', title: 'Train wake word', component: Screen }],
  tool: { title: 'Wake word', icon: 'account-voice', screen: 'wakeword' },
  settings: [{ title: 'Wake word', component: Settings, group: 'voice', icon: 'account-voice', order: 20, summary: useSummary }],
  setup: (ctx) => {
    const m = createWakewordModel({
      bus: ctx.bus,
      transport: ctx.ports.transport,
      online: () => ctx.connection.store.get().link === 'open',
      recorder: ctx.ports.recorder,
      data: ctx.ports.data,
      wakeWord: ctx.ports.wakeWord,
    });
    model = m;
    bus = ctx.bus;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default wakeword;
