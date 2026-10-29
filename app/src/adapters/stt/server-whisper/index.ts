// Adapter: SpeechToText via edith's whisper.cpp (POST /v1/stt, contracts/events.md).

import { str } from '../../../core/guards';
import type { SpeechToText, Transport } from '../../../core/ports';

/** Whisper on edith takes longer for longer clips: allow 20 s plus twice the audio, at most 150 s. */
export function sttTimeoutMs(durationMs = 30_000): number {
  return Math.min(150_000, 20_000 + 2 * durationMs);
}

export function createServerWhisper(transport: Transport): SpeechToText {
  return {
    async transcribe(audio) {
      const ext = audio.mime === 'audio/wav' ? 'wav' : (audio.mime.split('/')[1] ?? 'bin');
      const r = await transport.upload<Record<string, unknown>>('/v1/stt', { uri: audio.uri, mime: audio.mime, name: `speech.${ext}` }, { timeoutMs: sttTimeoutMs(audio.durationMs) });
      return { text: str(r.text).trim(), language: r.language ? str(r.language) : undefined };
    },
  };
}
