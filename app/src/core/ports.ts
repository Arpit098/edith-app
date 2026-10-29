// Ports: what features need from the outside world. Implementations live in src/adapters/.
// Features use these interfaces only, never a native module or library directly.

import type { EdithEvent } from './events';

/** Connection to the EDITH App API on edith (over Tailscale). */
export interface Transport {
  request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<T>;
  /** Live /v1/stream; returns an unsubscribe function. */
  stream(onEvent: (event: EdithEvent) => void, onState?: (state: 'connecting' | 'open' | 'closed') => void): () => void;
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

export interface SecureStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Ports {
  transport: Transport;
  stt: SpeechToText;
  tts: TextToSpeech;
  recorder: Recorder;
  wakeWord: WakeWord;
  storage: SecureStorage;
}
