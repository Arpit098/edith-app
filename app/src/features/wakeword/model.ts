// Wake word training (PLAN.md §4.5, contracts/wakeword.md): guided takes, checked on the phone, kept
// in the app's files and uploaded one at a time into a recording session on edith. The queue is saved
// after each change, so uploads carry on after a restart; a clip is keyed by its SHA-256, which makes a
// repeated upload harmless. Also the model's status and the Settings switch and sensitivity.

import { ApiError, isRetryable } from '../../core/api';
import type { EventBus } from '../../core/events';
import { num, str } from '../../core/guards';
import type { KeyValueStore, Recorder, RecorderEvent, Transport, WakeWord } from '../../core/ports';
import { createStore, type Store } from '../../core/store';
import { backoffDelay } from '../../common/backoff';
import { checkClip, stepOf, type ClipKind } from './plan';

export const STORE_KEY = 'wakeword.v1';
export const MAX_ATTEMPTS = 6; // retryable upload failures in a row before a clip waits for "Retry"
export const MAX_LOCAL_CLIPS = 60; // takes kept on the phone, not uploaded yet (each up to about 1 MB)
const BACKOFF = { baseMs: 1_000, maxMs: 30_000 };
const UPLOAD_TIMEOUT_MS = 60_000; // a 30 s noise clip is about 1 MB
export const DEFAULT_SENSITIVITY = 0.5;

export interface TrainClip {
  sha256: string;
  kind: ClipKind;
  uri: string | null; // the local file until it is uploaded
  seconds: number;
  status: 'queued' | 'uploaded' | 'failed';
  error: string | null;
}

export interface ModelInfo {
  version: string;
  createdAt: number; // unix seconds
  session: string | null;
  threshold: number | null;
  falseRejectRate: number | null;
  falseAcceptsPerHour: number | null;
  noiseFalseAcceptsPerHour: number | null;
}

export interface ModelStatus {
  state: 'no_recordings' | 'waiting_for_training' | 'trained';
  model: ModelInfo | null;
}

export type Take = { kind: ClipKind; kept: true; sha256: string } | { kind: ClipKind; kept: false; problems: string[] };

export interface WakewordState {
  loaded: boolean;
  label: string; // this install's session label: a lost answer to "create" finds its session again
  sessionId: string | null;
  clips: TrainClip[]; // kept takes, oldest first
  /** `startsAt` (unix ms): when a delayed take begins recording, for the countdown. */
  recording: { kind: ClipKind; phase: 'waiting' | 'recording'; elapsedMs: number; level: number; startsAt: number } | null;
  last: Take | null; // the newest take's verdict
  uploading: { sha256: string; sent: number; total: number } | null;
  /** ok; needs_update: the server has no wake word routes yet (404); unknown before the first answer. */
  server: 'unknown' | 'ok' | 'needs_update';
  status: ModelStatus | null;
  installed: { version: string } | null; // the model this app version bundles
  enabled: boolean;
  sensitivity: number; // 0..1, used by the detector (Phase 4)
  error: string | null;
}

interface Saved {
  label: string;
  sessionId: string | null;
  clips: TrainClip[];
  enabled: boolean;
  sensitivity: number;
}

export interface WakewordModel {
  store: Store<WakewordState>;
  record(kind: ClipKind): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  /** Drop a kept clip (a bad take noticed later): local file and, once uploaded, on edith. */
  remove(sha256: string): Promise<void>;
  retry(sha256: string): void;
  refreshStatus(): Promise<void>;
  setEnabled(on: boolean): Promise<void>;
  setSensitivity(v: number): void;
  dispose(): void;
}

/** The server answered 404 because the route itself is missing (not a missing session or clip). */
function routeMissing(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404 && e.message !== 'no such session' && e.message !== 'no such clip';
}

const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** This install's session label: unique, within the contract's 60 characters. */
function newLabel(): string {
  const hex = Array.from({ length: 8 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `Phone ${hex}`;
}

export function modelStatusFrom(r: Record<string, unknown>): ModelStatus {
  const state = r.state === 'trained' || r.state === 'waiting_for_training' ? r.state : 'no_recordings';
  const m = r.model as Record<string, unknown> | null | undefined;
  if (!m || typeof m !== 'object') return { state, model: null };
  const metrics = (m.metrics ?? {}) as Record<string, unknown>;
  return {
    state,
    model: {
      version: str(m.version),
      createdAt: num(m.created_at),
      session: m.session == null ? null : str(m.session),
      threshold: numOrNull(m.threshold),
      falseRejectRate: numOrNull(metrics.false_reject_rate),
      falseAcceptsPerHour: numOrNull(metrics.false_accepts_per_hour),
      noiseFalseAcceptsPerHour: numOrNull(metrics.noise_false_accepts_per_hour),
    },
  };
}

export function createWakewordModel(deps: {
  bus: EventBus;
  transport: Transport;
  online: () => boolean; // the App API is reachable now (the stream is open)
  recorder?: Recorder;
  data?: KeyValueStore;
  wakeWord?: WakeWord;
}): WakewordModel {
  const { bus, transport, recorder, data, wakeWord } = deps;
  const store = createStore<WakewordState>({
    loaded: false,
    label: '',
    sessionId: null,
    clips: [],
    recording: null,
    last: null,
    uploading: null,
    server: 'unknown',
    status: null,
    installed: wakeWord?.model() ?? null,
    enabled: false,
    sensitivity: DEFAULT_SENSITIVITY,
    error: null,
  });
  let disposed = false;
  let pumping = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let starting = false; // between the tap and the recorder starting (permission, delay)
  let take = 0; // the take being started: a stop or cancel meanwhile makes it stale

  const patch = (p: Partial<WakewordState>) => store.set((s) => ({ ...s, ...p }));
  const patchClip = (sha256: string, p: Partial<TrainClip>) => store.set((s) => ({ ...s, clips: s.clips.map((c) => (c.sha256 === sha256 ? { ...c, ...p } : c)) }));

  // ---- saved state: written after each change to what it holds (AsyncStorage writes a key atomically) ----

  let savedRef: Saved | null = null;
  function save() {
    const s = store.get();
    if (!s.loaded || !data) return;
    if (savedRef && savedRef.label === s.label && savedRef.sessionId === s.sessionId && savedRef.clips === s.clips && savedRef.enabled === s.enabled && savedRef.sensitivity === s.sensitivity) return;
    savedRef = { label: s.label, sessionId: s.sessionId, clips: s.clips, enabled: s.enabled, sensitivity: s.sensitivity };
    void data.set(STORE_KEY, JSON.stringify(savedRef)).catch((e) => console.warn('[edith] wake word state not saved', e));
  }
  const unsave = store.subscribe(save);

  async function load() {
    let saved: Partial<Saved> = {};
    try {
      const raw = data ? await data.get(STORE_KEY) : null;
      if (raw) saved = JSON.parse(raw) as Partial<Saved>;
    } catch (e) {
      console.warn('[edith] wake word state unreadable; starting fresh', e);
    }
    if (disposed) return;
    const clips = Array.isArray(saved.clips) ? saved.clips.filter((c) => c && typeof c.sha256 === 'string') : [];
    const installed = store.get().installed;
    await dropOrphans(clips);
    if (disposed) return;
    patch({
      loaded: true,
      label: typeof saved.label === 'string' && saved.label ? saved.label : newLabel(),
      sessionId: typeof saved.sessionId === 'string' ? saved.sessionId : null,
      clips,
      enabled: !!saved.enabled && !!installed, // never on without a model
      sensitivity: typeof saved.sensitivity === 'number' ? Math.min(1, Math.max(0, saved.sensitivity)) : DEFAULT_SENSITIVITY,
    });
    pump();
  }

  /** Kept files no queued clip points at (a crash between recording and saving): deleted at startup. */
  async function dropOrphans(clips: TrainClip[]) {
    if (!recorder?.kept || !recorder.discard) return;
    try {
      const wanted = new Set(clips.map((c) => c.uri).filter((u): u is string => !!u));
      for (const uri of await recorder.kept()) if (!wanted.has(uri)) await recorder.discard(uri);
    } catch (e) {
      console.warn('[edith] wake word clips not tidied', e); // harmless: tried again next start
    }
  }

  // ---- recording ----

  const offRecorder =
    recorder?.onEvent((e: RecorderEvent) => {
      const r = store.get().recording;
      if (!r || r.phase !== 'recording') return;
      if (e.kind === 'capped') void stop();
      else patch({ recording: { ...r, elapsedMs: e.elapsedMs, level: e.level } });
    }) ?? (() => {});

  async function record(kind: ClipKind) {
    if (!recorder || !store.get().loaded || store.get().recording || starting) return;
    const local = store.get().clips.filter((c) => c.uri).length;
    if (local >= MAX_LOCAL_CLIPS) {
      patch({ error: `${local} takes are waiting to upload. Connect to edith so they can go up before recording more.` });
      return;
    }
    starting = true;
    let allowed = false;
    try {
      allowed = await recorder.ensurePermission();
    } finally {
      starting = false;
    }
    if (!allowed) {
      patch({ error: 'EDITH needs the microphone to record. Allow it in Android’s settings.' });
      return;
    }
    const step = stepOf(kind);
    const mine = ++take;
    const startsAt = Date.now() + step.delayMs;
    patch({ recording: { kind, phase: 'waiting', elapsedMs: 0, level: 0, startsAt }, last: null, error: null });
    const current = () => mine === take && store.get().recording !== null;
    const begin = async () => {
      startTimer = null;
      if (!current()) return; // cancelled while waiting
      try {
        await recorder.start({ maxMs: step.maxMs, keep: true });
      } catch (e) {
        if (current()) patch({ recording: null, error: `Couldn’t start recording: ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
      // Stop or cancel pressed while the recorder was starting: don't leave the take running.
      if (!current()) {
        await recorder.cancel();
        return;
      }
      patch({ recording: { kind, phase: 'recording', elapsedMs: 0, level: 0, startsAt } });
    };
    if (step.delayMs > 0) startTimer = setTimeout(() => void begin(), step.delayMs);
    else await begin();
  }

  async function stop() {
    const r = store.get().recording;
    if (!recorder || !r || stopping) return;
    if (r.phase === 'waiting') return cancel();
    stopping = true;
    try {
      const audio = await recorder.stop();
      patch({ recording: null });
      if (!audio) return;
      if (!audio.analysis) {
        // A recorder that can't measure a take can't be trusted with training data.
        await recorder.discard?.(audio.uri);
        patch({ error: 'This recorder can’t check clips.' });
        return;
      }
      const a = audio.analysis;
      const problems = checkClip(r.kind, audio.durationMs, a);
      const dup = store.get().clips.some((c) => c.sha256 === a.sha256);
      if (problems.length || dup) {
        await recorder.discard?.(audio.uri);
        patch({ last: { kind: r.kind, kept: false, problems: problems.length ? problems : ['The same take is already kept.'] } });
        return;
      }
      const clip: TrainClip = { sha256: a.sha256, kind: r.kind, uri: audio.uri, seconds: audio.durationMs / 1000, status: 'queued', error: null };
      store.set((s) => ({ ...s, clips: [...s.clips, clip], last: { kind: r.kind, kept: true, sha256: a.sha256 } }));
      pump();
    } catch (e) {
      patch({ recording: null, error: `Recording failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      stopping = false;
    }
  }

  async function cancel() {
    const r = store.get().recording;
    if (!r) return;
    if (startTimer) clearTimeout(startTimer);
    startTimer = null;
    take++; // a start still in flight sees it is stale and cancels itself
    patch({ recording: null });
    if (r.phase === 'recording') await recorder?.cancel();
  }

  // ---- uploads: one at a time, in order ----

  const clipsPath = (sid: string, kind: ClipKind) => `/v1/wakeword/sessions/${encodeURIComponent(sid)}/clips?kind=${kind}`;

  async function ensureSession(): Promise<string> {
    const { sessionId: have, label } = store.get();
    if (have) return have;
    // A session made before whose answer was lost: find it by this install's label, never make a second
    // one (they count toward edith's cap of 20).
    const listing = await transport.request<Record<string, unknown>>('GET', '/v1/wakeword/sessions');
    const found = (Array.isArray(listing.sessions) ? listing.sessions : []).find((x: Record<string, unknown>) => x?.label === label) as Record<string, unknown> | undefined;
    const s = found ?? (await transport.request<Record<string, unknown>>('POST', '/v1/wakeword/sessions', { label }));
    const id = str(s.id);
    if (!id) throw new ApiError(502, 'edith sent no session id');
    patch({ sessionId: id });
    return id;
  }

  function scheduleRetry() {
    if (retryTimer || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      pump();
    }, backoffDelay(attempts - 1, BACKOFF));
  }

  function pump() {
    const s = store.get();
    if (pumping || disposed || !s.loaded || s.server === 'needs_update' || retryTimer || !deps.online()) return;
    const next = s.clips.find((c) => c.status === 'queued');
    if (!next) return;
    pumping = true;
    void uploadOne(next).finally(() => {
      pumping = false;
      patch({ uploading: null });
      if (!retryTimer) pump();
    });
  }

  async function uploadOne(clip: TrainClip) {
    let uploaded = false;
    try {
      const sid = await ensureSession();
      if (!clip.uri) throw new ApiError(400, 'the recording is gone from the phone');
      patch({ uploading: { sha256: clip.sha256, sent: 0, total: 0 } });
      await transport.uploadRaw(clipsPath(sid, clip.kind), { uri: clip.uri, mime: 'audio/wav', name: `${clip.sha256}.wav` }, {
        timeoutMs: UPLOAD_TIMEOUT_MS,
        headers: { 'x-clip-sha256': clip.sha256 },
        onProgress: (sent, total) => patch({ uploading: { sha256: clip.sha256, sent, total } }),
      });
      attempts = 0;
      uploaded = true;
      patchClip(clip.sha256, { status: 'uploaded', uri: null, error: null });
      if (store.get().server !== 'ok') patch({ server: 'ok' });
    } catch (e) {
      if (routeMissing(e)) {
        patch({ server: 'needs_update' }); // waits for the next connect
      } else if (e instanceof ApiError && e.status === 404) {
        // The session was deleted on edith: start a new one. Clips still on the phone go up again; the
        // ones already uploaded (their files deleted here) went with the session and are recorded anew.
        store.set((s) => ({ ...s, sessionId: null, clips: s.clips.filter((c) => c.uri).map((c) => ({ ...c, status: 'queued' as const, error: null })) }));
      } else if (isRetryable(e) && ++attempts < MAX_ATTEMPTS) {
        scheduleRetry();
      } else {
        attempts = 0;
        patchClip(clip.sha256, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
      }
    }
    // Outside the upload's try: a file that can't be deleted never makes an uploaded clip "failed"
    // (an orphan is tidied at the next start).
    if (uploaded && clip.uri) await recorder?.discard?.(clip.uri).catch((e) => console.warn('[edith] uploaded clip not deleted', e));
  }

  function retry(sha256: string) {
    patchClip(sha256, { status: 'queued', error: null });
    pump();
  }

  async function remove(sha256: string) {
    const clip = store.get().clips.find((c) => c.sha256 === sha256);
    if (!clip) return;
    if (store.get().uploading?.sha256 === sha256) {
      patch({ error: 'That take is uploading right now. Redo it once the upload finishes (a few seconds).' });
      return;
    }
    const sid = store.get().sessionId;
    if (clip.status === 'uploaded' && sid) {
      try {
        await transport.request('DELETE', `/v1/wakeword/sessions/${encodeURIComponent(sid)}/clips/${sha256}`);
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) {
          patch({ error: `Couldn’t delete it on edith: ${e instanceof Error ? e.message : String(e)}` });
          return;
        }
      }
    }
    if (clip.uri) await recorder?.discard?.(clip.uri);
    store.set((s) => ({ ...s, clips: s.clips.filter((c) => c.sha256 !== sha256), last: s.last?.kept && s.last.sha256 === sha256 ? null : s.last }));
  }

  // ---- model status ----

  async function refreshStatus() {
    try {
      const r = await transport.request<Record<string, unknown>>('GET', '/v1/wakeword/model');
      patch({ status: modelStatusFrom(r), server: 'ok' });
      pump();
    } catch (e) {
      if (routeMissing(e)) patch({ server: 'needs_update' });
    }
  }

  // ---- settings ----

  async function setEnabled(on: boolean) {
    const s = store.get();
    if (on && !s.installed) return; // train a model first
    patch({ enabled: on });
    // TODO(Phase 4): the always-on detector (WakeWordService, PLAN.md §4.4) behind this port.
    try {
      if (on) await wakeWord?.enable({ sensitivity: s.sensitivity });
      else await wakeWord?.disable();
    } catch (e) {
      patch({ enabled: !on, error: `Couldn’t turn “Hey Edith” ${on ? 'on' : 'off'}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function setSensitivity(v: number) {
    patch({ sensitivity: Math.min(1, Math.max(0, Math.round(v * 20) / 20)) }); // steps of 0.05
  }

  const offConnected = bus.on(
    'app.connected',
    () => {
      if (store.get().server === 'needs_update') patch({ server: 'unknown' }); // edith may have been updated
      void refreshStatus();
    },
    'wakeword',
  );

  void load();

  return {
    store,
    record,
    stop,
    cancel,
    remove,
    retry,
    refreshStatus,
    setEnabled,
    setSensitivity,
    dispose() {
      disposed = true;
      offConnected();
      offRecorder();
      unsave();
      if (retryTimer) clearTimeout(retryTimer);
      if (startTimer) clearTimeout(startTimer);
    },
  };
}
