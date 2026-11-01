// The Settings row's line for Voice input: whether the mic sends at once or fills the box first.

import type { VoiceState } from './voice';

export function voiceSummary(s: Pick<VoiceState, 'available' | 'autoSend'>): string {
  if (!s.available) return 'Not available';
  return s.autoSend ? 'Sends right after speaking' : 'Fills the box to edit first';
}
