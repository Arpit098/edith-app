// The Settings row's line for the wake word: on or off, and the takes recorded for training.

import type { WakewordState } from './model';

export function wakewordSummary(s: WakewordState): string {
  const on = s.enabled ? '“Hey Edith” on' : 'Off';
  const n = s.clips.length;
  return n ? `${on} · ${n} take${n === 1 ? '' : 's'} recorded` : on;
}
