// Which picked files to delete at startup (pure: tested without native code).

export const KEEP_MS = 8 * 86400_000; // a day past the server's 7-day id lifetime: no message can use them after that
export const KEEP_BYTES = 200 * 1024 * 1024; // at most this much, oldest deleted first

/** Files to delete so none is older than keepMs and the total stays within keepBytes (oldest go first). */
export function toPrune<T extends { size: number; mtime: number }>(files: T[], nowMs: number, keepMs = KEEP_MS, keepBytes = KEEP_BYTES): T[] {
  const newestFirst = [...files].sort((a, b) => b.mtime - a.mtime);
  const out: T[] = [];
  let total = 0;
  for (const f of newestFirst) {
    total += f.size;
    if (nowMs - f.mtime > keepMs || total > keepBytes) out.push(f);
  }
  return out;
}
