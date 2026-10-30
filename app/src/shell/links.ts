// Deep links (edith://<screen>): what a tapped notification or the Live Alerts pill opens.
// Android brings the one EDITH activity forward (singleTask) and hands it the link; no new activity.

import { useEffect, useRef } from 'react';
import { Linking } from 'react-native';

/** "edith://approvals" → "approvals" if that screen exists, else `fallback`; null for other links. */
export function linkScreen(url: string | null, has: (screen: string) => boolean, fallback: string): string | null {
  const m = /^edith:\/\/([a-z0-9-]+)/i.exec(url ?? '');
  if (!m) return null;
  const screen = m[1]!.toLowerCase();
  return has(screen) ? screen : fallback;
}

/** Calls `open` with the link EDITH was launched with, then with each link it receives while running. */
export function useDeepLinks(open: (url: string) => void): void {
  const latest = useRef(open);
  latest.current = open;
  useEffect(() => {
    let live = true;
    Linking.getInitialURL().then(
      (url) => live && url && latest.current(url),
      () => {},
    );
    const sub = Linking.addEventListener('url', (e) => latest.current(e.url));
    return () => {
      live = false;
      sub.remove();
    };
  }, []);
}
