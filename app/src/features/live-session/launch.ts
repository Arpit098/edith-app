// What edith://live/<action> does once the chat is on top (the home-screen EDITH bar's buttons,
// contracts/widgets.md): type (the box focused, keyboard up), listen (push-to-talk already
// recording) or attach (the composer's menu open on Camera, Gallery…).

import type { Store } from '../../core/store';
import type { VoiceModel } from './voice';

export type LaunchAction = 'type' | 'listen' | 'attach';

const ACTIONS: ReadonlySet<string> = new Set<LaunchAction>(['type', 'listen', 'attach']);

export function launchAction(action: string): LaunchAction | null {
  return ACTIONS.has(action) ? (action as LaunchAction) : null;
}

/**
 * Carries out a link's action. `focus` is a request the composer takes up (and clears) once it is
 * drawn, so a link that started EDITH still focuses the box when the composer mounts after it.
 */
export function createLaunch(deps: { voice: VoiceModel; menu: Store<boolean>; focus: Store<boolean> }): (action: string) => void {
  const { voice, menu, focus } = deps;
  return (raw) => {
    const action = launchAction(raw);
    if (!action) return;
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
