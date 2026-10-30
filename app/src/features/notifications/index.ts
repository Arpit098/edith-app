// Notifications: replies, approvals (Allow/Deny right in the notification), reminders and errors,
// while the app is connected. Needs the Notifier port (absent in tests and on web).

import type { FeatureModule } from '../../core/feature';
import { createNotifications } from './model';

const notifications: FeatureModule = {
  id: 'notifications',
  setup: ({ bus, api, ports }) => {
    if (!ports.notifier) return;
    const m = createNotifications({ bus, api, notifier: ports.notifier, transport: ports.transport, visibility: ports.visibility });
    return () => m.dispose();
  },
};

export default notifications;
