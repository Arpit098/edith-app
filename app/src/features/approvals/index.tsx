// Approvals: Allow/Deny for Claude's permission prompts, shown as a banner above every screen, and
// on their own screen (edith://approvals, opened from a notification or the Live Alerts pill).

import type { FeatureModule } from '../../core/feature';
import { str } from '../../core/guards';
import { createStore, useStore } from '../../core/store';
import { ApprovalsBanner } from './ApprovalsBanner';
import { ApprovalsScreen } from './ApprovalsScreen';
import { createApprovalsModel, type ApprovalsModel } from './model';

let model: ApprovalsModel | null = null;
const onOwnScreen = createStore(false); // the banner hides there: the screen shows the same cards
const selectSelf = (v: boolean) => v;

function Banner() {
  const hidden = useStore(onOwnScreen, selectSelf);
  return model && !hidden ? <ApprovalsBanner model={model} /> : null;
}

function Screen() {
  return model ? <ApprovalsScreen model={model} /> : null;
}

const approvals: FeatureModule = {
  id: 'approvals',
  screens: [{ name: 'approvals', title: 'Approvals', component: Screen }],
  panels: [{ slot: 'banner', component: Banner }],
  setup: ({ bus, api }) => {
    const m = createApprovalsModel(bus, api);
    model = m;
    const off = bus.on('app.screen', (e) => onOwnScreen.set(str(e.data.name) === 'approvals'), 'approvals');
    return () => {
      off();
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default approvals;
