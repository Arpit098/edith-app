// Settings → Voice input: send right after speaking, or put the words in the box to edit (default).

import { createSelector, shallowEqual, useStore } from '../../core/store';
import { Helper, Section, SettingsPageBody, SummaryCard, SwitchRow } from '../../ui/SettingsRows';
import { voiceSummary } from './summary';
import type { VoiceModel, VoiceState } from './voice';

// Not the mic's level while recording: only what this page shows.
const selectState = createSelector((s: VoiceState) => ({ available: s.available, autoSend: s.autoSend }), shallowEqual);

export function VoiceSettings({ voice }: { voice: VoiceModel }) {
  const s = useStore(voice.store, selectState);
  if (!s.available) {
    return (
      <SettingsPageBody>
        <SummaryCard icon="microphone-off" title="Voice input" subtitle="Not available" />
        <Helper>The microphone isn't available in this build.</Helper>
      </SettingsPageBody>
    );
  }
  return (
    <SettingsPageBody>
      <SummaryCard icon="microphone-outline" title="Voice input" subtitle={voiceSummary(s)} />
      <Section title="After you speak" footer={s.autoSend ? 'The mic sends what you said straight away.' : 'What you said goes into the box first, so you can edit it.'}>
        <SwitchRow icon="send-outline" label="Send right after speaking" value={s.autoSend} onChange={(on) => void voice.setAutoSend(on)} />
      </Section>
    </SettingsPageBody>
  );
}
