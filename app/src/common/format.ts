// Shared helpers used by more than one feature. common/ may import core/ only, never features/ or adapters/.

/** "5m ago", "3h ago", "2d ago" for a unix timestamp in seconds. */
export function timeAgo(ts: number, now: number = Date.now() / 1000): string {
  const s = Math.max(0, Math.floor(now - ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST_OFFSET_S = 5.5 * 3600; // Asia/Kolkata: UTC+5:30 all year (no DST)

/** "29 Oct, 18:05 IST" for a unix timestamp in seconds. Times shown to Arpit are always IST. */
export function formatIST(ts: number): string {
  const d = new Date((ts + IST_OFFSET_S) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hh}:${mm} IST`;
}

/** "15.4 MB" */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The first paragraph of a reply: what is spoken aloud in voice mode (same rule as the server). */
export function voiceSummary(text: string): string {
  return ((text ?? '').trim().split('\n\n', 1)[0] ?? '').trim();
}
