// Approvals: Allow/Deny for Claude's permission prompts, shown as a banner above every screen.

import type { FeatureModule } from '../../core/feature';
import { ApprovalsBanner } from './ApprovalsBanner';
import { createApprovalsModel, type ApprovalsModel } from './model';

let model: ApprovalsModel | null = null;

function Banner() {
  return model ? <ApprovalsBanner model={model} /> : null;
}

const approvals: FeatureModule = {
  id: 'approvals',
  panels: [{ slot: 'banner', component: Banner }],
  setup: ({ bus, api }) => {
    const m = createApprovalsModel(bus, api);
    model = m;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default approvals;
