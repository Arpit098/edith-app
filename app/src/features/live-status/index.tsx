// Live status: EDITH's state in the phone's Live Alerts pill (Android 16 Live Updates; an ongoing
// notification on older Android). Needs the OngoingStatus port (absent in tests and on web).

import type { FeatureModule } from '../../core/feature';
import type { AppVisibility, OngoingStatus } from '../../core/ports';
import { LiveAlertsSettings } from './LiveAlertsSettings';
import { createLiveStatus } from './model';
import { liveAlertsSummary } from './summary';

let ports: { status: OngoingStatus; visibility?: AppVisibility } | null = null;

function Settings() {
  return ports ? <LiveAlertsSettings status={ports.status} visibility={ports.visibility} /> : null;
}

// Read as the row renders (coming back to Settings re-renders it): no store to follow.
const summary = () => (ports ? liveAlertsSummary(ports.status.liveUpdates, ports.status.canPromote()) : 'Not available on this phone');

const liveStatus: FeatureModule = {
  id: 'live-status',
  settings: [{ title: 'Live Alerts', component: Settings, group: 'notifications', icon: 'message-badge-outline', order: 20, summary }],
  setup: ({ bus, api, ports: p }) => {
    if (!p.status) return;
    const mine = { status: p.status, visibility: p.visibility };
    ports = mine;
    const m = createLiveStatus({ bus, api, status: p.status, transport: p.transport });
    return () => {
      m.dispose();
      if (ports === mine) ports = null;
    };
  },
};

export default liveStatus;
