// What edith://live/<action> does once the chat is on top (the home-screen EDITH bar's buttons,
// contracts/widgets.md): type (the box focused, keyboard up), listen (push-to-talk already
// recording) or attach (the composer's menu open on Camera, Gallery…).
//
// Any app or web page can send an edith:// link, so listen and attach run only for a `trusted` link:
// one carrying this install's widget key (the LaunchLinks port). Any other just opens the chat, with
// the mic ready but not recording.

import type { Store } from '../../core/store';
import type { VoiceModel } from './voice';

export type LaunchAction = 'type' | 'listen' | 'attach';

const ACTIONS: ReadonlySet<string> = new Set<LaunchAction>(['type', 'listen', 'attach']);
/** Only from the widget's own links: they reach the microphone or the camera. */
const GUARDED: ReadonlySet<LaunchAction> = new Set<LaunchAction>(['listen', 'attach']);

export function launchAction(action: string): LaunchAction | null {
  return ACTIONS.has(action) ? (action as LaunchAction) : null;
}

/**
 * Carries out a link's action. `focus` is a request the composer takes up (and clears) once it is
 * drawn, so a link that started EDITH still focuses the box when the composer mounts after it.
 */
export function createLaunch(deps: { voice: VoiceModel; menu: Store<boolean>; focus: Store<boolean> }): (action: string, trusted: boolean) => void {
  const { voice, menu, focus } = deps;
  return (raw, trusted) => {
    const action = launchAction(raw);
    if (!action || (GUARDED.has(action) && !trusted)) return;
    const v = voice.store.get();
    if (action === 'attach') {
      if (v.phase === 'idle') menu.set(true);
      return;
    }
    menu.set(false);
    if (v.phase !== 'idle') return; // already listening (or transcribing): leave it be
    // No microphone here (web, an older build): typing is the next best thing.
    if (action === 'listen' && v.available) void voice.start();
    else focus.set(true);
  };
}
