// Push: replies, approvals and reminders while the app is closed, through edith's ntfy
// (contracts/push.md). Needs ports.push (the native service; absent in tests and on web).

import type { Connection } from '../../core/connection';
import type { FeatureModule } from '../../core/feature';
import { createPushModel, defaultNtfyUrl, type PushModel } from './model';
import { PushSettings } from './PushSettings';

let current: { model: PushModel; connection: Connection } | null = null;

function Settings() {
  return current ? <PushSettings model={current.model} defaultUrl={defaultNtfyUrl(current.connection.store.get().baseUrl)} /> : null;
}

const push: FeatureModule = {
  id: 'push',
  settings: [{ title: 'Push', component: Settings }],
  setup: ({ ports, api, connection }) => {
    if (!ports.push) return;
    const mine = {
      model: createPushModel({
        push: ports.push,
        api,
        transport: ports.transport,
        connection,
        visibility: ports.visibility,
        ensurePermission: ports.notifier?.ensurePermission,
      }),
      connection,
    };
    current = mine;
    return () => {
      mine.model.dispose();
      if (current === mine) current = null;
    };
  },
};

export default push;
