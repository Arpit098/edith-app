import { ApiError } from '../../../core/api';
import type { EdithEvent } from '../../../core/events';
import type { RecordedAudio, Recorder, RecorderEvent, SpeechToText } from '../../../core/ports';
import { fakeContext, flush, MemoryStorage } from '../../../testing/fakes';
import { createVoiceModel, MAX_RECORDING_MS, sttError } from '../voice';

class FakeRecorder implements Recorder {
  allowed = true;
  started: number[] = [];
  cancelled = 0;
  audio: RecordedAudio | null = { uri: 'file:///cache/voice/a.wav', mime: 'audio/wav', durationMs: 2400 };
  failStart: Error | null = null;
  private handler: ((e: RecorderEvent) => void) | null = null;
  ensurePermission = async () => this.allowed;
  async start({ maxMs }: { maxMs: number }) {
    if (this.failStart) throw this.failStart;
    this.started.push(maxMs);
  }
  onEvent(h: (e: RecorderEvent) => void) {
    this.handler = h;
    return () => (this.handler = null);
  }
  stop = jest.fn(async () => this.audio);
  async cancel() {
    this.cancelled++;
  }
  emit(e: RecorderEvent) {
    this.handler?.(e);
  }
}

function setup(stt: SpeechToText['transcribe'] = async () => ({ text: 'check the disk space' })) {
  const ctx = fakeContext();
  ctx.transport.on('POST /v1/messages', { ref: 'app:1', lane: 'main' });
  const recorder = new FakeRecorder();
  const storage = new MemoryStorage();
  const voiceEvents: EdithEvent[] = [];
  ctx.bus.subscribe('app.voice', (e) => voiceEvents.push(e));
  const send = jest.fn(async (_text: string, _opts: { voice: boolean }) => {});
  const m = createVoiceModel({ bus: ctx.bus, send, storage, recorder, stt: { transcribe: jest.fn(stt) } });
  return { ctx, m, recorder, storage, voiceEvents, send };
}

describe('voice input', () => {
  it('records, shows progress, and puts the transcript in the box by default', async () => {
    const { m, recorder, voiceEvents, send } = setup();
    await m.start();
    expect(recorder.started).toEqual([MAX_RECORDING_MS]);
    expect(m.store.get().phase).toBe('recording');
    recorder.emit({ kind: 'progress', elapsedMs: 1200, level: 0.4 });
    expect(m.store.get()).toMatchObject({ elapsedMs: 1200, level: 0.4 });

    expect(await m.stop()).toBe('check the disk space');
    expect(m.store.get()).toMatchObject({ phase: 'idle', error: null });
    expect(send).not.toHaveBeenCalled();
    expect(voiceEvents.map((e) => (e.data as { state: string }).state)).toEqual(['listening', 'idle']);
  });

  it('sends straight away as a voice message (through the live send) when that setting is on, and remembers it', async () => {
    const { ctx, m, storage, send } = setup();
    await m.setAutoSend(true);
    expect(storage.data.get('edith.voice.autoSend')).toBe('1');
    await m.start();
    expect(await m.stop()).toBeNull();
    expect(send).toHaveBeenCalledWith('check the disk space', { voice: true });

    const again = createVoiceModel({ bus: ctx.bus, send, storage, recorder: new FakeRecorder(), stt: { transcribe: jest.fn() } });
    await flush();
    expect(again.store.get().autoSend).toBe(true);
  });

  it('stops by itself at the cap, once even if Arpit taps too', async () => {
    const { m, recorder } = setup();
    await m.start();
    recorder.emit({ kind: 'capped', elapsedMs: MAX_RECORDING_MS });
    const tapped = await m.stop();
    await flush();
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(tapped).toBe('check the disk space');
  });

  it('explains a missing permission, a failed start, silence and short clips', async () => {
    const denied = setup();
    denied.recorder.allowed = false;
    await denied.m.start();
    expect(denied.m.store.get()).toMatchObject({ phase: 'idle', error: expect.stringContaining('needs the microphone') });

    const busy = setup();
    busy.recorder.failStart = new Error('The microphone is busy or unavailable');
    await busy.m.start();
    expect(busy.m.store.get().error).toBe("Couldn't start the microphone: The microphone is busy or unavailable");

    const silent = setup(async () => ({ text: '' }));
    await silent.m.start();
    expect(await silent.m.stop()).toBeNull();
    expect(silent.m.store.get().error).toMatch(/Didn't catch anything/);

    const short = setup();
    short.recorder.audio = { uri: 'file:///x.wav', mime: 'audio/wav', durationMs: 120 };
    await short.m.start();
    expect(await short.m.stop()).toBeNull();
    expect(short.m.store.get().error).toMatch(/too short/);
  });

  it('turns whisper failures into plain messages', async () => {
    const down = setup(async () => {
      throw new ApiError(503, 'whisper is down');
    });
    await down.m.start();
    await down.m.stop();
    expect(down.m.store.get().error).toMatch(/Speech-to-text is down on edith/);

    expect(sttError(new ApiError(0, 'Network request failed'))).toMatch(/Can't reach edith/);
    expect(sttError(new ApiError(0, 'timed out'))).toMatch(/took too long/);
    expect(sttError(new ApiError(429, 'busy'))).toMatch(/busy/);
    expect(sttError(new ApiError(413, 'too long'))).toMatch(/60 s/);
    expect(sttError(new ApiError(504, 'x'))).toMatch(/Whisper took too long/);
  });

  it('cancels without sending, and is unavailable without a recorder', async () => {
    const { m, recorder } = setup();
    await m.start();
    await m.cancel();
    expect(recorder.cancelled).toBe(1);
    expect(m.store.get().phase).toBe('idle');

    const ctx = fakeContext();
    const none = createVoiceModel({ bus: ctx.bus, send: async () => {}, storage: new MemoryStorage() });
    expect(none.store.get().available).toBe(false);
    await none.start();
    expect(none.store.get().phase).toBe('idle');
  });
});
