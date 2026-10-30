import { ApiError } from '../../../../core/api';
import { BINARY_CONTENT, uploadRaw, type CreateUploadTask } from '../upload';

const SERVER = { baseUrl: 'http://edith:8787', token: 't0k' };
const FILE = { uri: 'file:///cache/my photo.jpg', mime: 'image/jpeg', name: 'my photo é.jpg' };

function task(result: () => Promise<{ status: number; body: string } | null>) {
  const seen: { url?: string; uri?: string; options?: Parameters<CreateUploadTask>[2]; cancelled: number } = { cancelled: 0 };
  const create: CreateUploadTask = (url, uri, options, onProgress) => {
    Object.assign(seen, { url, uri, options });
    return {
      uploadAsync: async () => {
        onProgress({ totalBytesSent: 10, totalBytesExpectedToSend: 40 });
        return result();
      },
      cancelAsync: async () => {
        seen.cancelled++;
      },
    };
  };
  return { create, seen };
}

describe('uploadRaw', () => {
  it('streams the file as the raw body with the contract headers, and reports progress', async () => {
    const { create, seen } = task(async () => ({ status: 200, body: '{"id":"att_1"}' }));
    const progress: number[][] = [];
    const r = await uploadRaw<{ id: string }>(SERVER, '/v1/attachments', FILE, { timeoutMs: 1000, onProgress: (s, t) => progress.push([s, t]) }, create);
    expect(r).toEqual({ id: 'att_1' });
    expect(seen.url).toBe('http://edith:8787/v1/attachments');
    expect(seen.uri).toBe(FILE.uri);
    expect(seen.options).toEqual({
      httpMethod: 'POST',
      uploadType: BINARY_CONTENT,
      headers: { Authorization: 'Bearer t0k', Accept: 'application/json', 'Content-Type': 'image/jpeg', 'x-filename': 'my%20photo%20%C3%A9.jpg' },
    });
    expect(progress).toEqual([[10, 40]]);
  });

  it('turns an error status into an ApiError with the server message', async () => {
    const { create } = task(async () => ({ status: 413, body: '{"error":"too big"}' }));
    await expect(uploadRaw(SERVER, '/v1/attachments', FILE, { timeoutMs: 1000 }, create)).rejects.toEqual(new ApiError(413, 'too big'));
    const { create: notFound } = task(async () => ({ status: 404, body: 'Not Found' }));
    await expect(uploadRaw(SERVER, '/v1/attachments', FILE, { timeoutMs: 1000 }, notFound)).rejects.toMatchObject({ status: 404, message: 'HTTP 404' });
  });

  it('cancels the task on timeout', async () => {
    jest.useFakeTimers();
    try {
      let resolve: (v: null) => void = () => {};
      const { create, seen } = task(() => new Promise((r) => (resolve = r)));
      const p = uploadRaw(SERVER, '/v1/attachments', FILE, { timeoutMs: 1000 }, create);
      jest.advanceTimersByTime(1000);
      expect(seen.cancelled).toBe(1);
      resolve(null); // a cancelled upload resolves empty
      await expect(p).rejects.toMatchObject({ status: 0, message: 'timed out' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('needs a server', async () => {
    const { create } = task(async () => ({ status: 200, body: '{}' }));
    await expect(uploadRaw(null, '/v1/attachments', FILE, { timeoutMs: 1000 }, create)).rejects.toMatchObject({ status: 0 });
  });
});
