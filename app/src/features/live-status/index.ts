// Live status: EDITH's state in the phone's Live Alerts pill (Android 16 Live Updates; an ongoing
// notification on older Android). Needs the OngoingStatus port (absent in tests and on web).

import type { FeatureModule } from '../../core/feature';
import { createLiveStatus } from './model';

const liveStatus: FeatureModule = {
  id: 'live-status',
  setup: ({ bus, api, ports }) => {
    if (!ports.status) return;
    const m = createLiveStatus({ bus, api, status: ports.status, transport: ports.transport });
    return () => m.dispose();
  },
};

export default liveStatus;
