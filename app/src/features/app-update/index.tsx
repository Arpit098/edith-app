// App updates: OTA code bundles and new APKs from edith, from Settings (contracts/app-updates.md).

import type { FeatureModule } from '../../core/feature';
import { useStoreOr } from '../../core/store';
import { toast } from '../../ui/toast';
import { createAppUpdateModel, type AppUpdateModel } from './model';
import { updateSummary } from './summary';
import { UpdateSection } from './UpdateSection';

let model: AppUpdateModel | null = null;

function Section() {
  return model ? <UpdateSection model={model} /> : null;
}

function useSummary() {
  return useStoreOr(model?.store, updateSummary, null);
}

const appUpdate: FeatureModule = {
  id: 'app-update',
  settings: [{ title: 'Updates', component: Section, group: 'app', icon: 'cellphone-arrow-down', order: 10, summary: useSummary }],
  setup: ({ bus, api, ports }) => {
    const m = createAppUpdateModel({ bus, api, transport: ports.transport, installer: ports.installer, ota: ports.ota, notify: toast });
    model = m;
    return () => {
      m.dispose();
      if (model === m) model = null;
    };
  },
};

export default appUpdate;
