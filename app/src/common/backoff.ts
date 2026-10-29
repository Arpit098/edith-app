export interface Backoff {
  baseMs: number;
  maxMs: number;
}

/**
 * Exponential backoff with jitter: attempt 0 waits ~base, then doubles up to max. The delay is
 * drawn from [d/2, d] so a phone that lost the server doesn't retry in lockstep with itself.
 */
export function backoffDelay(attempt: number, { baseMs, maxMs }: Backoff, random: () => number = Math.random): number {
  const d = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20));
  return Math.round(d / 2 + (random() * d) / 2);
}

/** Resolves after `ms`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
