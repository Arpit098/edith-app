// The Settings row's line for Push: off, or on in which mode (and whether it's reaching edith).

import type { PushState } from './model';

export function pushSummary(s: PushState): string {
  const { status } = s;
  if (!status.enabled) return 'Off';
  const mode = status.mode === 'poll' ? 'Every 15 min' : 'Instant';
  if (status.error) return `On · ${mode} · not reaching edith`;
  return status.connected || status.mode === 'poll' ? `On · ${mode}` : `On · ${mode} · connecting`;
}
