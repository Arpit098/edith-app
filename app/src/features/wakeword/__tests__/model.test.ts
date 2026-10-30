import { ApiError } from '../../../core/api';
import { localEvent } from '../../../core/events';
import type { AudioAnalysis, KeyValueStore, RecordedAudio, Recorder, RecorderEvent, WakeWord } from '../../../core/ports';
import { fakeContext, flush } from '../../../testing/fakes';
import { createWakewordModel, MAX_ATTEMPTS, STORE_KEY, type WakewordModel } from '../model';
import { checkClip } from '../plan';

const good: AudioAnalysis = { peakDbfs: -8, rmsDbfs: -30, clipped: 0, sha256: 'a'.repeat(64), bytes: 48_000 };

describe('checkClip', () => {
  it('keeps a clean take', () => {
    expect(checkClip('positive_near', 1500, good)).toEqual([]);
    expect(checkClip('noise', 30_000, { ...good, peakDbfs: -40 })).toEqual([]);
  });

  it('asks for a redo when too short, clipped or too quiet', () => {
    expect(checkClip('positive_near', 300, good)).toEqual(['Too short: say the whole “Hey Edith”.']);
    expect(checkClip('positive_near', 1500, { ...good, clipped: 40 })).toEqual(['Too loud: it clipped. Hold the phone a bit further away.']);
    expect(checkClip('positive_near', 1500, { ...good, clipped: 3 })).toEqual([]); // a few samples are fine
    expect(checkClip('positive_near', 1500, { ...good, peakDbfs: -30 })).toEqual(['Too quiet: speak up or move closer.']);
    expect(checkClip('positive_whisper', 1500, { ...good, peakDbfs: -30 })).toEqual([]); // whispers may be quieter
    expect(checkClip('noise', 5_000, { ...good, peakDbfs: -90 })).toEqual(['Too short: let it record for at least 10 seconds.', 'Almost silent: is the microphone covered?']);
  });
});

class FakeRecorder implements Recorder {
  allowed = true;
  started: { maxMs: number; keep?: boolean }[] = [];
  discarded: string[] = [];
  next: RecordedAudio | null = null;
  private handlers = new Set<(e: RecorderEvent) => void>();
  async ensurePermission() {
    return this.allowed;
  }
  async start(opts: { maxMs: number; keep?: boolean }) {
    this.started.push(opts);
  }
  onEvent(h: (e: RecorderEvent) => void) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  emit(e: RecorderEvent) {
    this.handlers.forEach((h) => h(e));
  }
  async stop() {
    return this.next;
  }
  async cancel() {}
  async discard(uri: string) {
    this.discarded.push(uri);
  }
}

class MemoryData implements KeyValueStore {
  map = new Map<string, string>();
  async get(k: string) {
    return this.map.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.map.set(k, v);
  }
  async remove(k: string) {
    this.map.delete(k);
  }
}

const take = (sha: string, durationMs = 1500, a: Partial<AudioAnalysis> = {}): RecordedAudio => ({
  uri: `file:///clips/${sha}.wav`,
  mime: 'audio/wav',
  durationMs,
  analysis: { ...good, sha256: sha, ...a },
});

const clipAnswer = (sha: string) => ({ clip: { sha256: sha, kind: 'positive_near', seconds: 1.5 }, created: true });

function setup(opts: { data?: MemoryData; online?: boolean; wakeWord?: WakeWord } = {}) {
  const ctx = fakeContext();
  ctx.transport.configure({ baseUrl: 'http://edith:8787', token: 't' });
  const recorder = new FakeRecorder();
  const data = opts.data ?? new MemoryData();
  let online = opts.online ?? true;
  const m = createWakewordModel({ bus: ctx.bus, transport: ctx.transport, online: () => online, recorder, data, wakeWord: opts.wakeWord });
  return { ctx, recorder, data, m, setOnline: (v: boolean) => (online = v) };
}

async function recordTake(m: WakewordModel, recorder: FakeRecorder, audio: RecordedAudio, kind: 'positive_near' | 'noise' = 'positive_near') {
  await m.record(kind);
  recorder.next = audio;
  await m.stop();
  await flush();
}

describe('wake word model', () => {
  it('records a kept take into the app files, uploads it with its hash, then deletes the local copy', async () => {
    const { ctx, recorder, data, m } = setup();
    await flush();
    ctx.transport.on('POST /v1/wakeword/sessions', { id: '20261102-1043-a1b2' }).on('UPLOAD /v1/wakeword/sessions/20261102-1043-a1b2/clips?kind=positive_near', clipAnswer('s1'));
    await recordTake(m, recorder, take('s1'));
    expect(recorder.started).toEqual([{ maxMs: 4500, keep: true }]);
    expect(ctx.transport.uploads).toEqual([
      { path: '/v1/wakeword/sessions/20261102-1043-a1b2/clips?kind=positive_near', file: { uri: 'file:///clips/s1.wav', mime: 'audio/wav', name: 's1.wav' }, field: 'raw', headers: { 'x-clip-sha256': 's1' } },
    ]);
    expect(m.store.get().clips).toEqual([{ sha256: 's1', kind: 'positive_near', uri: null, seconds: 1.5, status: 'uploaded', error: null }]);
    expect(m.store.get().last).toEqual({ kind: 'positive_near', kept: true, sha256: 's1' });
    expect(recorder.discarded).toEqual(['file:///clips/s1.wav']);
    expect(JSON.parse(data.map.get(STORE_KEY)!)).toMatchObject({ sessionId: '20261102-1043-a1b2', clips: [{ sha256: 's1', status: 'uploaded' }] });
  });

  it('discards a bad take with what to fix, and a repeat of a kept one', async () => {
    const { ctx, recorder, m } = setup({ online: false });
    await flush();
    await recordTake(m, recorder, take('s1', 200));
    expect(m.store.get().last).toEqual({ kind: 'positive_near', kept: false, problems: ['Too short: say the whole “Hey Edith”.'] });
    await recordTake(m, recorder, take('s2'));
    await recordTake(m, recorder, take('s2'));
    expect(m.store.get().last).toMatchObject({ kept: false, problems: ['The same take is already kept.'] });
    expect(recorder.discarded).toEqual(['file:///clips/s1.wav', 'file:///clips/s2.wav']);
    expect(m.store.get().clips.map((c) => [c.sha256, c.status])).toEqual([['s2', 'queued']]); // offline: waits
    expect(ctx.transport.uploads).toEqual([]);
  });

  it('waits for the delay before recording across the room, and cancel stops it', async () => {
    jest.useFakeTimers();
    try {
      const { recorder, m } = setup();
      await m.record('positive_far' as never);
      expect(m.store.get().recording).toMatchObject({ kind: 'positive_far', phase: 'waiting' });
      expect(recorder.started).toEqual([]);
      await m.cancel();
      jest.advanceTimersByTime(5000);
      await flush();
      expect(recorder.started).toEqual([]);
      await m.record('positive_far' as never);
      jest.advanceTimersByTime(5000);
      await flush();
      expect(recorder.started).toHaveLength(1);
      expect(m.store.get().recording?.phase).toBe('recording');
      recorder.next = take('far1');
      recorder.emit({ kind: 'capped', elapsedMs: 4500 }); // stops by itself
      await flush();
      expect(m.store.get().recording).toBeNull();
      expect(m.store.get().clips.map((c) => c.kind)).toEqual(['positive_far']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('resumes the saved queue after a restart, and only when online', async () => {
    const data = new MemoryData();
    data.map.set(STORE_KEY, JSON.stringify({ sessionId: 'sess', clips: [{ sha256: 'q1', kind: 'noise', uri: 'file:///clips/q1.wav', seconds: 30, status: 'queued', error: null }], enabled: false, sensitivity: 0.7 }));
    const { ctx, m, setOnline } = setup({ data, online: false });
    ctx.transport.on('UPLOAD /v1/wakeword/sessions/sess/clips?kind=noise', clipAnswer('q1')).on('GET /v1/wakeword/model', { state: 'waiting_for_training', model: null });
    await flush();
    expect(m.store.get()).toMatchObject({ loaded: true, sensitivity: 0.7 });
    expect(ctx.transport.uploads).toEqual([]);
    setOnline(true);
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    await flush();
    expect(ctx.transport.uploads.map((u) => u.path)).toEqual(['/v1/wakeword/sessions/sess/clips?kind=noise']);
    expect(m.store.get().clips[0]!.status).toBe('uploaded');
  });

  it('retries a lost answer with backoff (the same hash is harmless), and gives up after a bound', async () => {
    jest.useFakeTimers();
    try {
      const { ctx, recorder, m } = setup();
      await flush();
      let calls = 0;
      ctx.transport.on('POST /v1/wakeword/sessions', { id: 'sess' }).on('UPLOAD /v1/wakeword/sessions/sess/clips?kind=positive_near', () => {
        calls++;
        throw new ApiError(0, 'timed out');
      });
      await recordTake(m, recorder, take('s1'));
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        jest.advanceTimersByTime(30_000);
        await flush();
      }
      expect(calls).toBe(MAX_ATTEMPTS);
      expect(m.store.get().clips[0]).toMatchObject({ status: 'failed', error: 'timed out' });
      ctx.transport.on('UPLOAD /v1/wakeword/sessions/sess/clips?kind=positive_near', { clip: {}, created: false });
      m.retry('s1');
      await flush();
      expect(m.store.get().clips[0]!.status).toBe('uploaded');
    } finally {
      jest.useRealTimers();
    }
  });

  it('says the server needs an update when the routes are missing (404), and tries again on the next connect', async () => {
    const { ctx, recorder, m } = setup();
    await flush();
    ctx.transport.on('POST /v1/wakeword/sessions', () => {
      throw new ApiError(404, 'not found');
    });
    await recordTake(m, recorder, take('s1'));
    expect(m.store.get().server).toBe('needs_update');
    expect(m.store.get().clips[0]!.status).toBe('queued'); // kept for later
    ctx.transport
      .on('GET /v1/wakeword/model', { state: 'no_recordings', model: null })
      .on('POST /v1/wakeword/sessions', { id: 'sess' })
      .on('UPLOAD /v1/wakeword/sessions/sess/clips?kind=positive_near', clipAnswer('s1'));
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    await flush();
    expect(m.store.get().server).toBe('ok');
    expect(m.store.get().clips[0]!.status).toBe('uploaded');
  });

  it('starts a new session when edith lost the old one, re-uploading what the phone still has', async () => {
    const data = new MemoryData();
    data.map.set(
      STORE_KEY,
      JSON.stringify({
        sessionId: 'gone',
        clips: [
          { sha256: 'up', kind: 'positive_near', uri: null, seconds: 1, status: 'uploaded', error: null },
          { sha256: 'q', kind: 'positive_near', uri: 'file:///clips/q.wav', seconds: 1, status: 'queued', error: null },
        ],
      }),
    );
    const { ctx, m } = setup({ data });
    ctx.transport
      .on('UPLOAD /v1/wakeword/sessions/gone/clips?kind=positive_near', () => {
        throw new ApiError(404, 'no such session');
      })
      .on('POST /v1/wakeword/sessions', { id: 'new' })
      .on('UPLOAD /v1/wakeword/sessions/new/clips?kind=positive_near', clipAnswer('q'));
    await flush();
    await flush();
    expect(m.store.get().sessionId).toBe('new');
    expect(m.store.get().clips.map((c) => [c.sha256, c.status])).toEqual([['q', 'uploaded']]);
  });

  it('removes a kept clip on edith and on the phone', async () => {
    const { ctx, recorder, m } = setup();
    await flush();
    ctx.transport.on('POST /v1/wakeword/sessions', { id: 'sess' }).on('UPLOAD /v1/wakeword/sessions/sess/clips?kind=positive_near', clipAnswer('s1'));
    ctx.transport.on('DELETE /v1/wakeword/sessions/sess/clips/s1', { deleted: 's1' });
    await recordTake(m, recorder, take('s1'));
    await m.remove('s1');
    expect(ctx.transport.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/wakeword/sessions/sess/clips/s1' });
    expect(m.store.get().clips).toEqual([]);
    expect(m.store.get().last).toBeNull();
  });

  it('shows the model status with its metrics', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('GET /v1/wakeword/model', {
      state: 'trained',
      model: { version: 'hey_edith-20261102-1130', created_at: 1793603400, session: 's', threshold: 0.5, metrics: { false_reject_rate: 0.031, false_accepts_per_hour: 0.4 } },
    });
    await m.refreshStatus();
    expect(m.store.get().status).toEqual({
      state: 'trained',
      model: { version: 'hey_edith-20261102-1130', createdAt: 1793603400, session: 's', threshold: 0.5, falseRejectRate: 0.031, falseAcceptsPerHour: 0.4, noiseFalseAcceptsPerHour: null },
    });
  });

  it('keeps "Hey Edith" off without a model, and stores the sensitivity', async () => {
    const { m, data } = setup();
    await flush();
    await m.setEnabled(true);
    expect(m.store.get().enabled).toBe(false);
    m.setSensitivity(0.734);
    await flush();
    expect(m.store.get().sensitivity).toBe(0.75);
    expect(JSON.parse(data.map.get(STORE_KEY)!).sensitivity).toBe(0.75);

    const enabled: number[] = [];
    const wakeWord: WakeWord = {
      enable: async ({ sensitivity }) => void enabled.push(sensitivity),
      disable: async () => {},
      isEnabled: async () => false,
      onDetected: () => () => {},
      model: () => ({ version: 'v1' }),
    };
    const withModel = setup({ wakeWord });
    await flush();
    await withModel.m.setEnabled(true);
    expect(withModel.m.store.get().enabled).toBe(true);
    expect(enabled).toEqual([0.5]);
  });

  it('asks for the microphone and says so when refused', async () => {
    const { recorder, m } = setup();
    recorder.allowed = false;
    await m.record('positive_near');
    expect(recorder.started).toEqual([]);
    expect(m.store.get().error).toMatch(/microphone/);
  });
});
