// Live status: EDITH's state in the phone's Live Alerts pill (Android 16 Live Updates; an ongoing
// notification on older Android). Needs the OngoingStatus port (absent in tests and on web).

import { useEffect, useState } from 'react';

import type { FeatureModule } from '../../core/feature';
import type { AppVisibility, OngoingStatus } from '../../core/ports';
import { LiveAlertsSettings } from './LiveAlertsSettings';
import { createLiveStatus } from './model';
import { liveAlertsSummary } from './summary';

let ports: { status: OngoingStatus; visibility?: AppVisibility } | null = null;

function Settings() {
  return ports ? <LiveAlertsSettings status={ports.status} visibility={ports.visibility} /> : null;
}

// Whether Live Updates are allowed is Android's switch, with no event: read once, then again each
// time EDITH comes back to the front (e.g. from that switch in Android's settings).
function useSummary() {
  const [allowed, setAllowed] = useState(() => ports?.status.canPromote() ?? false);
  useEffect(() => {
    const p = ports;
    return p?.visibility?.onChange((active) => active && setAllowed(p.status.canPromote()));
  }, []);
  return ports ? liveAlertsSummary(ports.status.liveUpdates, allowed) : 'Not available on this phone';
}

const liveStatus: FeatureModule = {
  id: 'live-status',
  settings: [{ title: 'Live Alerts', component: Settings, group: 'notifications', icon: 'message-badge-outline', order: 20, summary: useSummary }],
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
