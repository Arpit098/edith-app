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

/**
 * Downloads of files EDITH sent (./received) are kept as long as the server keeps their ids, 7 days
 * (contracts/attachments.md §4): after that the server answers 404 anyway, so an older copy is
 * deleted at startup and never reused.
 */
export const RECEIVED_KEEP_MS = 7 * 86400_000;

/**
 * Whether a cached download can be used instead of downloading again. The cache is keyed by the
 * server's id, and the server gives a file a new id whenever its contents may differ (path, inode,
 * size or mtime changed), so the same id with the same size is the same bytes. A copy past the 7 days
 * is treated as gone (startup deletes it too).
 */
export function usableCopy(copy: { exists: boolean; size: number; mtime: number | null }, expectedSize: number, nowMs: number, keepMs = RECEIVED_KEEP_MS): boolean {
  if (!copy.exists) return false;
  if (expectedSize >= 0 && copy.size !== expectedSize) return false; // a different or cut-off file
  return copy.mtime === null || nowMs - copy.mtime <= keepMs;
}
