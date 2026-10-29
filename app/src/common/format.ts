// Shared helpers used by more than one feature. common/ may import core/ only, never features/ or adapters/.

/** "5m ago", "3h ago", "2d ago" for a unix timestamp in seconds. */
export function timeAgo(ts: number, now: number = Date.now() / 1000): string {
  const s = Math.max(0, Math.floor(now - ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The first paragraph of a reply: what is spoken aloud in voice mode (same rule as the server). */
export function voiceSummary(text: string): string {
  return (text ?? '').trim().split('\n\n', 1)[0].trim();
}
