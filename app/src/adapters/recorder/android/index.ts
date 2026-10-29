// Adapter: the Recorder port on our native module android-modules/edith-recorder (16 kHz mono WAV).

import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid } from 'react-native';

import type { Recorder, RecorderEvent } from '../../../core/ports';

interface NativeRecorder {
  start(maxMs: number): Promise<void>;
  stop(): Promise<{ uri: string; durationMs: number; bytes: number } | null>;
  cancel(): Promise<void>;
  addListener(event: 'onRecording', listener: (e: { elapsedMs: number; level: number; capped?: boolean }) => void): { remove(): void };
}

/** Null where the native module isn't built in (jest, web). */
export function createAndroidRecorder(): Recorder | null {
  const native = requireOptionalNativeModule<NativeRecorder>('EdithRecorder');
  if (!native) return null;
  return {
    async ensurePermission() {
      const mic = 'android.permission.RECORD_AUDIO' as never;
      if (await PermissionsAndroid.check(mic)) return true;
      return (await PermissionsAndroid.request(mic)) === PermissionsAndroid.RESULTS.GRANTED;
    },
    start: ({ maxMs }) => native.start(Math.round(maxMs)),
    onEvent(handler) {
      const sub = native.addListener('onRecording', (e) =>
        handler((e.capped ? { kind: 'capped', elapsedMs: e.elapsedMs } : { kind: 'progress', elapsedMs: e.elapsedMs, level: e.level }) satisfies RecorderEvent),
      );
      return () => sub.remove();
    },
    async stop() {
      const r = await native.stop();
      return r ? { uri: r.uri, mime: 'audio/wav', durationMs: r.durationMs } : null;
    },
    cancel: () => native.cancel(),
  };
}
