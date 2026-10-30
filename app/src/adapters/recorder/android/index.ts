// Adapter: the Recorder port on our native module android-modules/edith-recorder (16 kHz mono WAV).

import { requireOptionalNativeModule } from 'expo';
import { PermissionsAndroid } from 'react-native';

import type { Recorder, RecorderEvent } from '../../../core/ports';

interface NativeRecorder {
  start(maxMs: number, keep: boolean): Promise<void>;
  stop(): Promise<{ uri: string; durationMs: number; bytes: number; peakDbfs: number; rmsDbfs: number; clipped: number; sha256: string } | null>;
  discard(uri: string): Promise<boolean>;
  keptFiles(): Promise<string[]>;
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
    start: ({ maxMs, keep }) => native.start(Math.round(maxMs), keep ?? false),
    onEvent(handler) {
      const sub = native.addListener('onRecording', (e) =>
        handler((e.capped ? { kind: 'capped', elapsedMs: e.elapsedMs } : { kind: 'progress', elapsedMs: e.elapsedMs, level: e.level }) satisfies RecorderEvent),
      );
      return () => sub.remove();
    },
    async stop() {
      const r = await native.stop();
      if (!r) return null;
      const analysis = { peakDbfs: r.peakDbfs, rmsDbfs: r.rmsDbfs, clipped: r.clipped, sha256: r.sha256, bytes: r.bytes };
      return { uri: r.uri, mime: 'audio/wav', durationMs: r.durationMs, analysis };
    },
    async discard(uri) {
      await native.discard(uri);
    },
    kept: () => native.keptFiles(),
    cancel: () => native.cancel(),
  };
}
