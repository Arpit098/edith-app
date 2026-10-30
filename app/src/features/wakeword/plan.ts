// The guided recording plan (PLAN.md §4.5) and the on-device checks each take must pass before it is
// kept and uploaded. Kinds and duration limits are contracts/wakeword.md §2.

import type { AudioAnalysis } from '../../core/ports';

export type ClipKind = 'positive_near' | 'positive_far' | 'positive_whisper' | 'noise';

export interface Step {
  kind: ClipKind;
  title: string;
  prompt: string;
  target: number; // clips wanted
  maxMs: number; // the recording stops by itself here
  delayMs: number; // time to get in place before it starts (across the room)
}

export const STEPS: readonly Step[] = [
  {
    kind: 'positive_near',
    title: 'Near',
    prompt: 'Hold the phone about an arm’s length away and say “Hey Edith” in your normal voice. Vary it a little each time.',
    target: 15,
    maxMs: 4500,
    delayMs: 0,
  },
  {
    kind: 'positive_far',
    title: 'Across the room',
    prompt: 'Put the phone down and walk across the room. Recording starts 5 seconds after you tap; then say “Hey Edith”.',
    target: 10,
    maxMs: 4500,
    delayMs: 5000,
  },
  {
    kind: 'positive_whisper',
    title: 'Whispered',
    prompt: 'Whisper “Hey Edith” towards the phone.',
    target: 5,
    maxMs: 4500,
    delayMs: 0,
  },
  {
    kind: 'noise',
    title: 'Home and TV noise',
    prompt: 'Leave the phone where you usually are, with the TV, music or people talking. Don’t say “Hey Edith”. Each clip records 30 seconds.',
    target: 5,
    maxMs: 30_000,
    delayMs: 0,
  },
];

export const stepOf = (kind: ClipKind): Step => STEPS.find((s) => s.kind === kind)!;

const RATE = 16_000;

/** Limits per kind: a take outside them is redone, never uploaded. */
const LIMITS: Record<ClipKind, { minMs: number; maxMs: number; minPeakDbfs: number }> = {
  positive_near: { minMs: 500, maxMs: 5000, minPeakDbfs: -24 },
  positive_far: { minMs: 500, maxMs: 5000, minPeakDbfs: -32 },
  positive_whisper: { minMs: 500, maxMs: 5000, minPeakDbfs: -38 },
  noise: { minMs: 10_000, maxMs: 120_000, minPeakDbfs: -60 },
};

/** At most this share of samples at full scale (and never more than a handful in a short take). */
const MAX_CLIPPED_SHARE = 0.0005;

/** What is wrong with a take, in words for Arpit; empty when it can be kept. */
export function checkClip(kind: ClipKind, durationMs: number, a: AudioAnalysis): string[] {
  const limits = LIMITS[kind];
  const problems: string[] = [];
  if (durationMs < limits.minMs) problems.push(kind === 'noise' ? 'Too short: let it record for at least 10 seconds.' : 'Too short: say the whole “Hey Edith”.');
  if (durationMs > limits.maxMs) problems.push('Too long.');
  if (a.clipped > Math.max(3, (durationMs / 1000) * RATE * MAX_CLIPPED_SHARE)) {
    problems.push(kind === 'noise' ? 'Too loud: it clipped. Move the phone away from the speaker.' : 'Too loud: it clipped. Hold the phone a bit further away.');
  }
  if (a.peakDbfs < limits.minPeakDbfs) {
    problems.push(kind === 'noise' ? 'Almost silent: is the microphone covered?' : kind === 'positive_far' ? 'Too quiet: speak up, or come a little closer.' : 'Too quiet: speak up or move closer.');
  }
  return problems;
}
