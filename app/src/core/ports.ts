// Ports: what features need from the outside world. Implementations live in src/adapters/.
// Features use these interfaces only, never a native module or library directly.

import type { EdithEvent } from './events';

/** Where the App API is and how to sign in (contracts/events.md, "App API"). */
export interface ServerConfig {
  baseUrl: string; // e.g. "http://100.101.102.103:8787", no trailing slash
  token: string;
}

export type StreamState = 'idle' | 'connecting' | 'open' | 'closed';

export interface StreamStatus {
  state: StreamState;
  /** For "closed": ms until the next automatic attempt, or null if it won't retry (e.g. a bad token). */
  retryInMs: number | null;
  error: string | null; // "unauthorized" for a rejected token, else a short reason
}

export interface RequestOptions {
  timeoutMs?: number;
}

/** Connection to the EDITH App API on edith (over Tailscale). */
export interface Transport {
  /** Set or clear the server. The stream (if anyone listens) reconnects to the new one. */
  configure(server: ServerConfig | null): void;
  request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, opts?: RequestOptions): Promise<T>;
  /**
   * Live /v1/stream over one shared WebSocket (reconnects with backoff on its own).
   * Returns an unsubscribe function; the socket closes when nobody listens.
   */
  stream(onEvent: (event: EdithEvent) => void, onStatus?: (status: StreamStatus) => void): () => void;
  /** Reconnect the stream now (skips the backoff wait), e.g. when Arpit taps "retry". */
  reconnect(): void;
  /** Absolute URL and auth headers for a request made outside this transport (a native download). */
  authorized(path: string): { url: string; headers: Record<string, string> } | null;
  /** POST a file as multipart/form-data (part `field`), answered with JSON. Sent once, never retried. */
  upload<T>(path: string, file: { uri: string; mime: string; name: string }, opts?: RequestOptions & { field?: string }): Promise<T>;
  /**
   * POST a file as the raw request body (with Content-Length; contracts/attachments.md), streamed from
   * disk, answered with JSON. Sent once, never retried.
   */
  uploadRaw<T>(
    path: string,
    file: { uri: string; mime: string; name: string },
    opts?: RequestOptions & { onProgress?: (sent: number, total: number) => void },
  ): Promise<T>;
}

/** A file Arpit picked to attach. */
export interface PickedFile {
  kind: 'image' | 'audio';
  uri: string;
  name: string;
  mime: string;
  size: number; // bytes, 0 if unknown
}

/** The camera, the gallery and the file picker. */
export interface MediaPicker {
  /** Null when Arpit cancels. Images come back as JPEG with the long edge at most 2048 px. */
  pickImage(source: 'camera' | 'library'): Promise<PickedFile | null>;
  pickAudio(): Promise<PickedFile | null>;
}

export type InstallStatus = 'pending' | 'success' | 'cancelled' | 'incompatible' | 'failed';

/** Downloads and installs a new EDITH APK (contracts/app-updates.md §5). Android shows its own confirmation. */
export interface AppInstaller {
  readonly versionName: string;
  readonly versionCode: number;
  /** Streams to the app's cache, checking SHA-256 as it goes; rejects on a mismatch. Resumes a partial file. */
  download(
    request: { url: string; headers: Record<string, string> },
    sha256: string,
    size: number,
    onProgress: (received: number, total: number) => void,
  ): Promise<{ path: string }>;
  /** Whether Android lets EDITH install apps ("Install unknown apps"). */
  canInstall(): Promise<boolean>;
  openInstallSettings(): Promise<void>;
  /** Hands the APK to Android's installer; the outcome arrives through onStatus. */
  install(path: string): Promise<void>;
  onStatus(handler: (status: InstallStatus, message: string) => void): () => void;
  clearDownloads(): Promise<void>;
}

export interface OtaInfo {
  enabled: boolean; // false when the APK was built without the OTA signing key
  updateId: string | null;
  createdAt: number | null; // unix seconds
  embedded: boolean; // running the APK's own bundle
  rolledBack: boolean; // a newer bundle crashed at launch and expo-updates fell back
  runtimeVersion: string | null;
}

/** Over-the-air JS bundles (expo-updates against the App API). */
export interface OtaUpdates {
  info(): OtaInfo;
  /** Send Arpit's token on update requests (only header names embedded at build time can be set). */
  setRequestHeaders(headers: Record<string, string>): void;
  /** Check and, if there's a newer bundle, download it. True when one is ready for the next start. */
  fetchUpdate(): Promise<boolean>;
  /** Restart the JS app now on the downloaded bundle. */
  reload(): Promise<void>;
}

export interface SpeechToText {
  /** Audio recorded on the phone -> text (today: whisper.cpp on edith). */
  transcribe(audio: { uri: string; mime: string; durationMs?: number }): Promise<{ text: string; language?: string }>;
}

export interface TextToSpeech {
  speak(text: string, opts?: { language?: string }): Promise<void>;
  stop(): void;
}

export interface RecordedAudio {
  uri: string; // file:// in the app's cache
  mime: string; // audio/wav: 16 kHz mono 16-bit
  durationMs: number;
}

export type RecorderEvent = { kind: 'progress'; elapsedMs: number; level: number } | { kind: 'capped'; elapsedMs: number };

/** The microphone. Push-to-talk today; end-of-speech detection (VAD) joins in Phase 3. */
export interface Recorder {
  /** Ask for the microphone permission if needed; true when it's granted. */
  ensurePermission(): Promise<boolean>;
  /** Start recording; it stops by itself at `maxMs` (a 'capped' event). */
  start(opts: { maxMs: number }): Promise<void>;
  /** Progress (elapsed, level 0..1) about 10 times a second while recording. */
  onEvent(handler: (e: RecorderEvent) => void): () => void;
  /** Finish and return the file, or null if nothing was recording. */
  stop(): Promise<RecordedAudio | null>;
  /** Stop and throw the recording away. */
  cancel(): Promise<void>;
}

export interface WakeWord {
  /** Manual toggle only: nothing listens unless Arpit turns it on (PLAN.md §4.8). */
  enable(opts: { sensitivity: number }): Promise<void>;
  disable(): Promise<void>;
  isEnabled(): Promise<boolean>;
  onDetected(handler: () => void): () => void;
}

/** Android Keystore-backed storage for the token and server address. */
/** String values by key. Each set() is atomic. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Small secrets (the token): Android Keystore-encrypted, a few KB at most per value. */
export type SecureStorage = KeyValueStore;

export interface Ports {
  transport: Transport;
  storage: SecureStorage;
  data?: KeyValueStore; // app data that isn't secret (the message outbox); absent in tests and web
  installer?: AppInstaller; // absent where the native module isn't (tests, web)
  ota?: OtaUpdates;
  stt?: SpeechToText; // push-to-talk (and Phase 3 voice)
  recorder?: Recorder;
  media?: MediaPicker; // attachments
  // Built in later phases (PLAN.md §6); absent until then.
  tts?: TextToSpeech; // Phase 3
  wakeWord?: WakeWord; // Phase 4
}
