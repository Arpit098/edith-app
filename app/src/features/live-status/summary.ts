// The Settings row's line for Live Alerts: the pill, Live Updates switched off for EDITH, or (before
// Android 16) an ongoing notification.

export function liveAlertsSummary(liveUpdates: boolean, allowed: boolean): string {
  if (!liveUpdates) return 'Ongoing notification';
  return allowed ? 'Shows in the pill' : 'Live Updates are off';
}
