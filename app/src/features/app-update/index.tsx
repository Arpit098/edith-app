// App updates: OTA code bundles and new APKs from edith, from Settings (contracts/app-updates.md), and
// a banner for an update not seen yet (the fallback when push is off).

import { useEffect } from 'react';

import { localEvent, type EventBus } from '../../core/events';
import type { FeatureModule } from '../../core/feature';
import { useStoreOr } from '../../core/store';
import { toast } from '../../ui/toast';
import { createAppUpdateModel, type AppUpdateModel } from './model';
import { updateSummary } from './summary';
import { UpdateBanner } from './UpdateBanner';
import { UpdateSection } from './UpdateSection';

export const SETTINGS_TITLE = 'Updates'; // the Settings page edith://settings/updates opens

let model: AppUpdateModel | null = null;
let bus: EventBus | null = null;

function Section() {
  useEffect(() => model?.opened(), []);
  return model ? <UpdateSection model={model} /> : null;
}

function Banner() {
  return model ? <UpdateBanner model={model} openUpdates={() => bus?.publish(localEvent('app.open', { screen: 'settings', page: SETTINGS_TITLE }))} /> : null;
}

function useSummary() {
  return useStoreOr(model?.store, updateSummary, null);
}

const appUpdate: FeatureModule = {
  id: 'app-update',
  settings: [{ title: SETTINGS_TITLE, component: Section, group: 'about', icon: 'cellphone-arrow-down', order: 10, summary: useSummary }],
  panels: [{ slot: 'banner', component: Banner }],
  setup: ({ bus: b, api, ports }) => {
    const m = createAppUpdateModel({
      bus: b,
      api,
      transport: ports.transport,
      installer: ports.installer,
      ota: ports.ota,
      data: ports.data,
      visibility: ports.visibility,
      notify: toast,
    });
    model = m;
    bus = b;
    return () => {
      m.dispose();
      if (model === m) {
        model = null;
        bus = null;
      }
    };
  },
};

export default appUpdate;
