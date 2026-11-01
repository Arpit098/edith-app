// Settings → Wake word: the "Hey Edith" switch (off by default, and only once a model is installed),
// the sensitivity, and the way to the training screen.

import type { EventBus } from '../../core/events';
import { localEvent } from '../../core/events';
import type { SettingsToggle } from '../../core/feature';
import { createSelector, shallowEqual, useStore } from '../../core/store';
import { PillButton, Row, Section, SettingsPageBody, SliderRow, SummaryCard } from '../../ui/SettingsRows';
import type { WakewordModel, WakewordState } from './model';

// Not every state change (a take's level while recording): only what this page shows.
const selectState = createSelector((s: WakewordState) => ({ enabled: s.enabled, installed: s.installed, sensitivity: s.sensitivity, takes: s.clips.length }), shallowEqual);

/** The switch in the Settings list: only once a model is installed. */
export function wakewordToggle(model: WakewordModel, s: Pick<WakewordState, 'enabled' | 'installed'>): SettingsToggle {
  return { on: s.enabled, set: (on) => void model.setEnabled(on), disabled: !s.installed };
}

export function WakeWordSettings({ model, bus }: { model: WakewordModel; bus: EventBus }) {
  const s = useStore(model.store, selectState);
  const installed = s.installed?.version ?? null;
  const takes = s.takes;
  return (
    <SettingsPageBody>
      <SummaryCard
        icon="account-voice"
        title="“Hey Edith”"
        subtitle={!installed ? 'Train a model first' : s.enabled ? 'On · listens for “Hey Edith”' : 'Off'}
        tone={s.enabled ? 'ok' : undefined}
        toggle={{ value: s.enabled, label: 'Hey Edith', disabled: !installed, onChange: (on) => void model.setEnabled(on) }}
      />
      <Section title="Listening" footer={installed ? 'Listens for “Hey Edith” while on. Off by default.' : 'Train a model first: record “Hey Edith” and some home noise.'}>
        <SliderRow label="Sensitivity" icon="tune-variant" value={s.sensitivity} onChange={model.setSensitivity} ends={['Fewer false wakes', 'Wakes more easily']} />
      </Section>
      <Section title="Model">
        <Row icon="cube-outline" label="Installed model" value={installed ?? 'None'} />
        <Row icon="microphone-outline" label="Takes recorded" value={String(takes)} />
      </Section>
      <PillButton label="Train wake word" icon="account-voice" variant="primary" onPress={() => bus.publish(localEvent('app.open', { screen: 'wakeword' }))} />
    </SettingsPageBody>
  );
}
