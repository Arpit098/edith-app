// Settings → Live Alerts: a notice while Live Updates are off for EDITH (OxygenOS asks for each app,
// and the pill never shows without it), the way to that switch, and a test of the pill that says
// what happened (the demo is silent and the pill hides while EDITH is open, so without words a
// working test looks like nothing). There's no on/off of EDITH's own here: the switch is Android's.

import { useEffect, useRef, useState } from 'react';

import type { AppVisibility, OngoingStatus } from '../../core/ports';
import { Helper, Notice, PillButton, Row, Section, SettingsPageBody, SummaryCard } from '../../ui/SettingsRows';
import { liveAlertsSummary } from './summary';

export function LiveAlertsSettings({ status, visibility }: { status: OngoingStatus; visibility?: AppVisibility }) {
  const [allowed, setAllowed] = useState(() => status.canPromote());
  // Back from Android's settings: read the switch again.
  useEffect(() => visibility?.onChange((active) => active && setAllowed(status.canPromote())), [status, visibility]);
  const off = status.liveUpdates && !allowed;
  const [demo, setDemo] = useState<{ ok: boolean; message: string } | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (clearTimer.current && clearTimeout(clearTimer.current)), []);
  const test = () => {
    let result: { ok: boolean; message: string };
    try {
      result = status.testIsland();
    } catch (e) {
      result = { ok: false, message: `Couldn’t run the demo: ${e instanceof Error ? e.message : String(e)}` };
    }
    setDemo(result);
    setAllowed(status.canPromote());
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = result.ok ? setTimeout(() => setDemo(null), DEMO_MS) : null; // the demo's own 30 s
  };
  return (
    <SettingsPageBody>
      <SummaryCard
        icon="message-badge-outline"
        title="Live Alerts"
        subtitle={liveAlertsSummary(status.liveUpdates, allowed)}
        tone={off ? 'warn' : status.liveUpdates ? 'ok' : undefined}
      />
      {off ? (
        <Notice text="Live Updates are off for EDITH, so its status can’t show in the Live Alerts pill." />
      ) : (
        <Helper>{status.liveUpdates ? 'EDITH’s status shows in the Live Alerts pill while a task runs.' : 'This phone shows EDITH’s status as an ongoing notification (Live Alerts need Android 16).'}</Helper>
      )}
      <Section title="Try it" footer={demo ? undefined : 'Shows a 30 s demo. Leave the app to see the pill.'}>
        <Row icon="play-circle-outline" label="Test island" onPress={test} chevron={false} />
        {status.liveUpdates && !off ? <Row icon="open-in-new" label="Live Updates in Android settings" onPress={() => status.openPromotionSettings()} /> : null}
      </Section>
      {demo ? <Helper live tone={demo.ok ? 'ok' : 'error'}>{demo.message}</Helper> : null}
      {off ? <PillButton label="Turn on Live Updates" icon="open-in-new" variant="primary" onPress={() => status.openPromotionSettings()} /> : null}
    </SettingsPageBody>
  );
}

const DEMO_MS = 30_000;
