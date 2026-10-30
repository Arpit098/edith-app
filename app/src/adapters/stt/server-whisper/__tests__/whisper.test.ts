import { ApiError } from '../../../../core/api';
import { FakeTransport } from '../../../../testing/fakes';
import { createServerWhisper, sttTimeoutMs } from '..';
import { httpUpload, type Fetch } from '../../../transport/edith-api/http';

describe('server whisper', () => {
  it('uploads the WAV as the multipart file part and reads the text', async () => {
    const t = new FakeTransport().on('UPLOAD /v1/stt', { text: '  check the disk  ', language: 'en', seconds: 1.2, duration: 2.4 });
    const stt = createServerWhisper(t);
    expect(await stt.transcribe({ uri: 'file:///c/a.wav', mime: 'audio/wav', durationMs: 2400 })).toEqual({ text: 'check the disk', language: 'en' });
    expect(t.uploads).toEqual([{ path: '/v1/stt', file: { uri: 'file:///c/a.wav', mime: 'audio/wav', name: 'speech.wav' }, field: 'file' }]);
  });

  it('allows more time for longer clips, within a ceiling', () => {
    expect(sttTimeoutMs(2_000)).toBe(24_000);
    expect(sttTimeoutMs(55_000)).toBe(130_000);
    expect(sttTimeoutMs(600_000)).toBe(150_000);
  });

  it('sends multipart with the token, once, and maps error answers', async () => {
    const calls: RequestInit[] = [];
    const fetch: Fetch = async (_url, init) => {
      calls.push(init);
      return { ok: false, status: 503, json: async () => ({ error: 'whisper is down' }) } as Response;
    };
    const server = { baseUrl: 'http://edith:8787', token: 'tok' };
    await expect(httpUpload(server, '/v1/stt', { uri: 'file:///a.wav', mime: 'audio/wav', name: 'speech.wav' }, 'file', 1000, fetch)).rejects.toEqual(
      new ApiError(503, 'whisper is down'),
    );
    expect(calls).toHaveLength(1); // never retried
    expect(calls[0]!.body).toBeInstanceOf(FormData);
    expect(calls[0]!.headers).toMatchObject({ Authorization: 'Bearer tok' });
    expect(calls[0]!.headers).not.toHaveProperty('Content-Type'); // fetch sets the multipart boundary
  });
});
