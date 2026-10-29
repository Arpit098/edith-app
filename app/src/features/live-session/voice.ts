// Push-to-talk in the composer (contracts/events.md, "Voice"): record 16 kHz mono WAV →
// POST /v1/stt → the text, either into the box to edit (default) or sent straight away as a voice
// message (POST /v1/messages {voice: true}).

import { ApiError, type Api } from '../../core/api';
import { localEvent, type EventBus } from '../../core/events';
import type { Recorder, SecureStorage, SpeechToText } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

export const MAX_RECORDING_MS = 55_000; // edith takes up to 60 s; a little margin
const AUTO_SEND_KEY = 'edith.voice.autoSend';

export type VoicePhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'sending';

export interface VoiceState {
  available: boolean; // false without a recorder or speech-to-text (e.g. web, tests)
  phase: VoicePhase;
  elapsedMs: number;
  level: number; // 0..1
  error: string | null;
  autoSend: boolean; // send right after speaking instead of putting the text in the box
}

export interface VoiceModel {
  store: Store<VoiceState>;
  start(): Promise<void>;
  /** Stop and transcribe. Returns the text to put in the box, or null (sent, empty or failed). */
  stop(): Promise<string | null>;
  cancel(): Promise<void>;
  setAutoSend(on: boolean): Promise<void>;
  dispose(): void;
}

/** What went wrong with /v1/stt, said plainly (statuses from contracts/events.md). */
export function sttError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.status) {
      case 0:
        return e.message === 'timed out'
          ? 'Transcribing took too long. Try a shorter message.'
          : "Can't reach edith to transcribe. Is Tailscale on?";
      case 503:
        return "Speech-to-text is down on edith (whisper isn't running, or is still loading). Try again in a minute.";
      case 504:
        return 'Whisper took too long on that one. Try a shorter message.';
      case 429:
        return 'Whisper is busy with another recording. Try again in a moment.';
      case 413:
        return 'That recording is too long (60 s at most).';
      case 400:
        return "edith couldn't read that recording. Try again.";
      case 502:
        return 'Whisper failed on that recording. Try again.';
    }
  }
  return `Couldn't transcribe: ${e instanceof Error ? e.message : String(e)}`;
}

export function createVoiceModel(deps: {
  bus: EventBus;
  api: Api;
  storage: SecureStorage;
  recorder?: Recorder;
  stt?: SpeechToText;
}): VoiceModel {
  const { bus, api, storage, recorder, stt } = deps;
  const store = createStore<VoiceState>({ available: !!(recorder && stt), phase: 'idle', elapsedMs: 0, level: 0, error: null, autoSend: false });
  let stopping: Promise<string | null> | null = null;
  let autoSendChosen = false; // set once Arpit changes it: a slower load must not undo that

  void storage.get(AUTO_SEND_KEY).then(
    (v) => {
      if (!autoSendChosen) store.set((s) => ({ ...s, autoSend: v === '1' }));
    },
    () => {}, // keep the default (show for editing)
  );

  const offRecorder = recorder?.onEvent((e) => {
    if (e.kind === 'progress') store.set((s) => (s.phase === 'recording' ? { ...s, elapsedMs: e.elapsedMs, level: e.level } : s));
    else void model.stop(); // hit the cap: finish as if Arpit tapped stop
  });

  const listening = (on: boolean) => bus.publish(localEvent('app.voice', { state: on ? 'listening' : 'idle' }));
  const fail = (error: string) => store.set((s) => ({ ...s, phase: 'idle', level: 0, error }));

  const model: VoiceModel = {
    store,
    async start() {
      if (!recorder || !stt || store.get().phase !== 'idle') return;
      store.set((s) => ({ ...s, phase: 'starting', error: null, elapsedMs: 0, level: 0 }));
      if (!(await recorder.ensurePermission())) {
        fail('EDITH needs the microphone to listen. Allow it in Android settings → Apps → EDITH → Permissions.');
        return;
      }
      try {
        await recorder.start({ maxMs: MAX_RECORDING_MS });
      } catch (e) {
        fail(`Couldn't start the microphone: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      store.set((s) => ({ ...s, phase: 'recording' }));
      listening(true);
    },

    stop() {
      // The cap and a tap can both ask; the second waits for the first.
      stopping ??= (async () => {
        if (!recorder || !stt || store.get().phase !== 'recording') return null;
        listening(false);
        store.set((s) => ({ ...s, phase: 'transcribing', level: 0 }));
        let text: string;
        try {
          const audio = await recorder.stop();
          if (!audio || audio.durationMs < 300) {
            fail('That was too short. Hold on a moment longer.');
            return null;
          }
          text = (await stt.transcribe(audio)).text;
        } catch (e) {
          fail(sttError(e));
          return null;
        }
        if (!text) {
          fail("Didn't catch anything. Try again a little closer to the mic.");
          return null;
        }
        if (!store.get().autoSend) {
          store.set((s) => ({ ...s, phase: 'idle' }));
          return text;
        }
        store.set((s) => ({ ...s, phase: 'sending' }));
        try {
          await api.send(text, { voice: true });
          store.set((s) => ({ ...s, phase: 'idle' }));
          return null;
        } catch (e) {
          // Keep the words: they go into the box so nothing Arpit said is lost.
          fail(`Not sent: ${e instanceof Error ? e.message : String(e)}`);
          return text;
        }
      })().finally(() => {
        stopping = null;
      });
      return stopping;
    },

    async cancel() {
      if (store.get().phase !== 'recording') return;
      await recorder?.cancel();
      listening(false);
      store.set((s) => ({ ...s, phase: 'idle', level: 0, elapsedMs: 0 }));
    },

    async setAutoSend(on) {
      autoSendChosen = true;
      store.set((s) => ({ ...s, autoSend: on }));
      await storage.set(AUTO_SEND_KEY, on ? '1' : '0');
    },

    dispose() {
      offRecorder?.();
      if (store.get().phase === 'recording') void recorder?.cancel();
    },
  };
  return model;
}
