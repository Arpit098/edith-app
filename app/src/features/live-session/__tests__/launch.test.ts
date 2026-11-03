import { createStore } from '../../../core/store';
import { createLaunch, launchAction } from '../launch';
import type { VoiceModel, VoicePhase, VoiceState } from '../voice';

function setup(voice: Partial<VoiceState> = {}) {
  const store = createStore<VoiceState>({ available: true, phase: 'idle', elapsedMs: 0, level: 0, error: null, autoSend: false, ...voice });
  const start = jest.fn(async () => {});
  const v = { store, start } as unknown as VoiceModel;
  const menu = createStore(false);
  const focus = createStore(false);
  return { launch: createLaunch({ voice: v, menu, focus }), start, menu, focus, store };
}

describe('launchAction', () => {
  it('knows the EDITH bar’s three actions and nothing else', () => {
    expect(['type', 'listen', 'attach', 'Type', 'updates', ''].map(launchAction)).toEqual(['type', 'listen', 'attach', null, null, null]);
  });
});

describe('createLaunch', () => {
  it('type: asks the composer for the box (keyboard up), with the menu closed', () => {
    const t = setup();
    t.menu.set(true);
    t.launch('type');
    expect(t.focus.get()).toBe(true);
    expect(t.menu.get()).toBe(false);
    expect(t.start).not.toHaveBeenCalled();
  });

  it('listen: starts push-to-talk at once', () => {
    const t = setup();
    t.launch('listen');
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.focus.get()).toBe(false);
  });

  it('listen without a microphone (web, tests) falls back to typing', () => {
    const t = setup({ available: false });
    t.launch('listen');
    expect(t.start).not.toHaveBeenCalled();
    expect(t.focus.get()).toBe(true);
  });

  it('attach: opens the composer menu (Camera, Gallery…)', () => {
    const t = setup();
    t.launch('attach');
    expect(t.menu.get()).toBe(true);
    expect(t.focus.get()).toBe(false);
  });

  it('leaves a recording (or a transcription) alone', () => {
    for (const phase of ['starting', 'recording', 'transcribing'] as VoicePhase[]) {
      const t = setup({ phase });
      t.launch('listen');
      t.launch('type');
      t.launch('attach');
      expect(t.start).not.toHaveBeenCalled();
      expect(t.focus.get()).toBe(false);
      expect(t.menu.get()).toBe(false);
    }
  });

  it('ignores actions it doesn’t know', () => {
    const t = setup();
    t.launch('approve');
    expect(t.start).not.toHaveBeenCalled();
    expect(t.focus.get()).toBe(false);
    expect(t.menu.get()).toBe(false);
  });
});
