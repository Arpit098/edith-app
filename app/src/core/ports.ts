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
}

export interface SpeechToText {
  /** Audio recorded on the phone -> text (today: whisper.cpp on edith). */
  transcribe(audio: { uri: string; mime: string }): Promise<{ text: string; language?: string }>;
}

export interface TextToSpeech {
  speak(text: string, opts?: { language?: string }): Promise<void>;
  stop(): void;
}

export interface Recorder {
  /** Records until silence (VAD) or until stop() is called. */
  start(opts?: { stopOnSilence?: boolean }): Promise<void>;
  stop(): Promise<{ uri: string; mime: string } | null>;
}

export interface WakeWord {
  /** Manual toggle only: nothing listens unless Arpit turns it on (PLAN.md §4.8). */
  enable(opts: { sensitivity: number }): Promise<void>;
  disable(): Promise<void>;
  isEnabled(): Promise<boolean>;
  onDetected(handler: () => void): () => void;
}

/** Android Keystore-backed storage for the token and server address. */
export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Ports {
  transport: Transport;
  storage: SecureStorage;
  // Built in later phases (PLAN.md §6); absent until then.
  stt?: SpeechToText; // Phase 3
  tts?: TextToSpeech; // Phase 3
  recorder?: Recorder; // Phase 3
  wakeWord?: WakeWord; // Phase 4
}
