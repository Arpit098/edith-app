import { ApiError } from '../../../core/api';
import { localEvent } from '../../../core/events';
import type { AudioAnalysis, KeyValueStore, RecordedAudio, Recorder, RecorderEvent, WakeWord } from '../../../core/ports';
import { fakeContext, flush } from '../../../testing/fakes';
import { createWakewordModel, MAX_ATTEMPTS, MAX_LOCAL_CLIPS, STORE_KEY, type WakewordModel } from '../model';
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
  cancelled = 0;
  files: string[] = []; // what kept() reports
  next: RecordedAudio | null = null;
  startGate: Promise<void> | null = null; // start() waits on it when set
  private handlers = new Set<(e: RecorderEvent) => void>();
  async ensurePermission() {
    return this.allowed;
  }
  async start(opts: { maxMs: number; keep?: boolean }) {
    this.started.push(opts);
    if (this.startGate) await this.startGate;
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
  async cancel() {
    this.cancelled++;
  }
  async discard(uri: string) {
    this.discarded.push(uri);
  }
  async kept() {
    return this.files;
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
  ctx.transport.on('GET /v1/wakeword/sessions', { sessions: [], usage: { bytes: 0, max_bytes: 1 } });
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
      await flush();
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
    const missing = () => {
      throw new ApiError(404, 'not found');
    };
    ctx.transport.on('GET /v1/wakeword/sessions', missing).on('POST /v1/wakeword/sessions', missing);
    await recordTake(m, recorder, take('s1'));
    expect(m.store.get().server).toBe('needs_update');
    expect(m.store.get().clips[0]!.status).toBe('queued'); // kept for later
    ctx.transport
      .on('GET /v1/wakeword/model', { state: 'no_recordings', model: null })
      .on('GET /v1/wakeword/sessions', { sessions: [] })
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
    await flush();
    recorder.allowed = false;
    await m.record('positive_near');
    expect(recorder.started).toEqual([]);
    expect(m.store.get().error).toMatch(/microphone/);
  });

  it('finds its own session after a lost answer instead of making a second one', async () => {
    const { ctx, recorder, m } = setup();
    await flush();
    const label = m.store.get().label;
    expect(label).toMatch(/^Phone [0-9a-f]{8}$/);
    let posts = 0;
    ctx.transport.on('POST /v1/wakeword/sessions', () => {
      posts++;
      throw new ApiError(0, 'timed out'); // created on edith, but the answer never came back
    });
    jest.useFakeTimers();
    try {
      await recordTake(m, recorder, take('s1'));
      ctx.transport
        .on('GET /v1/wakeword/sessions', { sessions: [{ id: 'other', label: 'Phone 00000000' }, { id: 'mine', label }] })
        .on('UPLOAD /v1/wakeword/sessions/mine/clips?kind=positive_near', clipAnswer('s1'));
      jest.advanceTimersByTime(30_000);
      await flush();
    } finally {
      jest.useRealTimers();
    }
    expect(posts).toBe(1);
    expect(m.store.get().sessionId).toBe('mine');
    expect(m.store.get().clips[0]!.status).toBe('uploaded');
  });

  it('deletes kept files that no saved clip points at, at startup', async () => {
    const data = new MemoryData();
    data.map.set(STORE_KEY, JSON.stringify({ label: 'Phone x', sessionId: null, clips: [{ sha256: 'q', kind: 'noise', uri: 'file:///clips/q.wav', seconds: 30, status: 'queued', error: null }] }));
    const ctx = fakeContext();
    const recorder = new FakeRecorder();
    recorder.files = ['file:///clips/q.wav', 'file:///clips/orphan.wav'];
    const m = createWakewordModel({ bus: ctx.bus, transport: ctx.transport, online: () => false, recorder, data });
    await flush();
    expect(recorder.discarded).toEqual(['file:///clips/orphan.wav']);
    expect(m.store.get()).toMatchObject({ loaded: true, label: 'Phone x' });
  });

  it('cancels a take whose stop came while the recorder was still starting', async () => {
    const { recorder, m } = setup({ online: false });
    await flush();
    let open!: () => void;
    recorder.startGate = new Promise((r) => (open = r));
    const recording = m.record('positive_near');
    await flush();
    await m.stop(); // pressed before start() returned
    open();
    await recording;
    expect(recorder.cancelled).toBe(1);
    expect(m.store.get().recording).toBeNull();
  });

  it('keeps an uploaded clip uploaded when its local file can’t be deleted', async () => {
    const { ctx, recorder, m } = setup();
    await flush();
    recorder.discard = async () => {
      throw new Error('disk full');
    };
    ctx.transport.on('POST /v1/wakeword/sessions', { id: 'sess' }).on('UPLOAD /v1/wakeword/sessions/sess/clips?kind=positive_near', clipAnswer('s1'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await recordTake(m, recorder, take('s1'));
    expect(m.store.get().clips[0]).toMatchObject({ status: 'uploaded', error: null });
  });

  it('stops recording when too many takes wait on the phone', async () => {
    const data = new MemoryData();
    const clips = Array.from({ length: MAX_LOCAL_CLIPS }, (_, i) => ({ sha256: `q${i}`, kind: 'positive_near', uri: `file:///clips/q${i}.wav`, seconds: 1, status: 'queued', error: null }));
    data.map.set(STORE_KEY, JSON.stringify({ label: 'Phone x', sessionId: null, clips }));
    const { recorder, m } = setup({ data, online: false });
    recorder.files = clips.map((c) => c.uri);
    await flush();
    await m.record('positive_near');
    expect(recorder.started).toEqual([]);
    expect(m.store.get().error).toMatch(/waiting to upload/);
  });

  it('says why a take can’t be redone while it uploads', async () => {
    const { ctx, recorder, m } = setup();
    await flush();
    let finish!: (v: unknown) => void;
    ctx.transport.on('POST /v1/wakeword/sessions', { id: 'sess' }).on('UPLOAD /v1/wakeword/sessions/sess/clips?kind=positive_near', () => new Promise((r) => (finish = r)));
    await recordTake(m, recorder, take('s1'));
    expect(m.store.get().uploading?.sha256).toBe('s1');
    await m.remove('s1');
    expect(m.store.get().clips).toHaveLength(1);
    expect(m.store.get().error).toMatch(/uploading right now/);
    finish(clipAnswer('s1'));
    await flush();
  });

  it('deletes all recordings: every session on edith, the queue and every file on the phone', async () => {
    const data = new MemoryData();
    data.map.set(STORE_KEY, JSON.stringify({ label: 'Phone x', sessionId: 'a', clips: [{ sha256: 'q', kind: 'noise', uri: 'file:///clips/q.wav', seconds: 30, status: 'failed', error: 'x' }] }));
    const { ctx, recorder, m } = setup({ data });
    recorder.files = ['file:///clips/q.wav'];
    await flush();
    recorder.files = ['file:///clips/q.wav', 'file:///clips/stray.wav'];
    ctx.transport
      .on('GET /v1/wakeword/sessions', { sessions: [{ id: 'a', label: 'Phone x' }, { id: 'b', label: 'Phone y' }] })
      .on('DELETE /v1/wakeword/sessions/a', { deleted: 'a' })
      .on('DELETE /v1/wakeword/sessions/b', () => {
        throw new ApiError(404, 'no such session');
      })
      .on('GET /v1/wakeword/model', { state: 'no_recordings', model: null });
    expect(await m.deleteAll()).toBe(true);
    expect(ctx.transport.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/v1/wakeword/sessions/a', '/v1/wakeword/sessions/b']);
    expect(recorder.discarded.sort()).toEqual(['file:///clips/q.wav', 'file:///clips/stray.wav']);
    expect(m.store.get()).toMatchObject({ sessionId: null, clips: [], last: null });
  });

  it('waits for the upload in flight before deleting, and keeps everything if edith fails', async () => {
    const { ctx, recorder, m } = setup();
    await flush();
    let finish!: (v: unknown) => void;
    ctx.transport.on('POST /v1/wakeword/sessions', { id: 'sess' }).on('UPLOAD /v1/wakeword/sessions/sess/clips?kind=positive_near', () => new Promise((r) => (finish = r)));
    await recordTake(m, recorder, take('s1'));
    ctx.transport.on('GET /v1/wakeword/sessions', () => {
      throw new ApiError(503, 'busy');
    });
    const listings = () => ctx.transport.calls.filter((c) => c.method === 'GET' && c.path === '/v1/wakeword/sessions').length;
    const before = listings();
    const done = m.deleteAll();
    await flush();
    expect(listings()).toBe(before); // still waiting on the upload
    finish(clipAnswer('s1'));
    expect(await done).toBe(false);
    expect(m.store.get().clips.map((c) => c.sha256)).toEqual(['s1']); // nothing dropped on the phone
    expect(m.store.get().error).toMatch(/Couldn’t delete the recordings on edith: busy/);
  });

  const uploaded = (sha: string) => ({ sha256: sha, kind: 'positive_near', uri: null, seconds: 1, status: 'uploaded', error: null });

  it('reconciles with edith when the session was deleted there: uploaded clips go, takes on the phone stay and go up again', async () => {
    const data = new MemoryData();
    const clips = [uploaded('u1'), uploaded('u2'), uploaded('u3'), uploaded('u4'), uploaded('u5'), { sha256: 'local', kind: 'noise', uri: 'file:///clips/local.wav', seconds: 30, status: 'failed', error: 'x' }];
    data.map.set(STORE_KEY, JSON.stringify({ label: 'Phone x', sessionId: '20261030-2002-2b8f', clips }));
    const { ctx, m } = setup({ data });
    await flush();
    expect(m.store.get().clips.filter((c) => c.status === 'uploaded')).toHaveLength(5); // "5 recordings done"
    ctx.transport
      .on('GET /v1/wakeword/sessions/20261030-2002-2b8f/manifest', () => {
        throw new ApiError(404, 'no such session'); // deleted on edith
      })
      .on('GET /v1/wakeword/model', { state: 'no_recordings', model: null })
      .on('POST /v1/wakeword/sessions', { id: 'fresh' })
      .on('UPLOAD /v1/wakeword/sessions/fresh/clips?kind=noise', clipAnswer('local'));
    await m.refreshStatus(); // the screen opens (or the app reconnects)
    await flush();
    expect(m.store.get().sessionId).toBe('fresh');
    expect(m.store.get().clips.map((c) => [c.sha256, c.status])).toEqual([['local', 'uploaded']]);
  });

  it('reconciles a session that lost some clips, keeping the rest', async () => {
    const data = new MemoryData();
    data.map.set(STORE_KEY, JSON.stringify({ label: 'Phone x', sessionId: 'sess', clips: [uploaded('u1'), uploaded('u2'), uploaded('u3')] }));
    const { ctx, m } = setup({ data, online: false });
    await flush();
    ctx.transport.on('GET /v1/wakeword/sessions/sess/manifest', { clips: [{ sha256: 'u1' }, { sha256: 'u3' }] }).on('GET /v1/wakeword/model', { state: 'waiting_for_training', model: null });
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(m.store.get().sessionId).toBe('sess');
    expect(m.store.get().clips.map((c) => c.sha256)).toEqual(['u1', 'u3']);
  });

  it('keeps everything when edith can’t be asked', async () => {
    const data = new MemoryData();
    data.map.set(STORE_KEY, JSON.stringify({ label: 'Phone x', sessionId: 'sess', clips: [uploaded('u1')] }));
    const { ctx, m } = setup({ data, online: false });
    await flush();
    ctx.transport.on('GET /v1/wakeword/sessions/sess/manifest', () => {
      throw new ApiError(0, 'timed out');
    });
    await m.refreshStatus();
    expect(m.store.get()).toMatchObject({ sessionId: 'sess', clips: [{ sha256: 'u1', status: 'uploaded' }] });
  });
});
