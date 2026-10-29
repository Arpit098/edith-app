import { ApiError } from '../../../../core/api';
import { backoffDelay } from '../backoff';
import { httpRequest, type Fetch, type HttpOptions } from '../http';

const SERVER = { baseUrl: 'http://edith:8787', token: 't0k' };

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('empty');
      return body;
    },
  } as Response;
}

function opts(fetch: Fetch): HttpOptions {
  return { fetch, timeoutMs: 1000, attempts: 3, backoff: { baseMs: 1, maxMs: 2 } };
}

describe('backoffDelay', () => {
  it('doubles up to the cap, with jitter in [d/2, d]', () => {
    const b = { baseMs: 1000, maxMs: 30_000 };
    expect(backoffDelay(0, b, () => 0)).toBe(500);
    expect(backoffDelay(0, b, () => 1)).toBe(1000);
    expect(backoffDelay(3, b, () => 1)).toBe(8000);
    expect(backoffDelay(50, b, () => 1)).toBe(30_000);
  });
});

describe('httpRequest', () => {
  it('sends JSON with the bearer token and returns the body', async () => {
    const fetch = jest.fn<Promise<Response>, Parameters<Fetch>>(async () => response(200, { ref: 'a' }));
    expect(await httpRequest(SERVER, 'POST', '/v1/messages', { text: 'hi' }, {}, opts(fetch))).toEqual({ ref: 'a' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://edith:8787/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"text":"hi"}');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer t0k', 'Content-Type': 'application/json' });
  });

  it('turns error answers into ApiError with the server message', async () => {
    const fetch: Fetch = async () => response(404, { error: 'That request has expired.' });
    await expect(httpRequest(SERVER, 'POST', '/v1/permissions/ab', { allow: true }, {}, opts(fetch))).rejects.toEqual(
      new ApiError(404, 'That request has expired.'),
    );
    const bare: Fetch = async () => response(500, undefined);
    await expect(httpRequest(SERVER, 'GET', '/v1/status', undefined, {}, opts(bare))).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });

  it('retries GET on network errors and 503, but sends POST once', async () => {
    const fetch = jest
      .fn<Promise<Response>, Parameters<Fetch>>()
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(response(503, { error: 'whisper is down' }))
      .mockResolvedValueOnce(response(200, { ok: 1 }));
    expect(await httpRequest(SERVER, 'GET', '/v1/status', undefined, {}, opts(fetch))).toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledTimes(3);

    const post = jest.fn<Promise<Response>, Parameters<Fetch>>().mockRejectedValue(new TypeError('Network request failed'));
    await expect(httpRequest(SERVER, 'POST', '/v1/messages', { text: 'x' }, {}, opts(post))).rejects.toMatchObject({
      status: 0,
      message: 'Network request failed',
    });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not retry 4xx', async () => {
    const fetch = jest.fn<Promise<Response>, Parameters<Fetch>>(async () => response(401, { error: 'unauthorized' }));
    await expect(httpRequest(SERVER, 'GET', '/v1/status', undefined, {}, opts(fetch))).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('times out a request that hangs', async () => {
    jest.useFakeTimers();
    try {
      const fetch: Fetch = (_url, init) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('Aborted'))));
      const p = httpRequest(SERVER, 'POST', '/v1/stop', undefined, { timeoutMs: 50 }, opts(fetch));
      jest.advanceTimersByTime(60);
      await expect(p).rejects.toEqual(new ApiError(0, 'timed out'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses when no server is configured', async () => {
    await expect(httpRequest(null, 'GET', '/v1/status', undefined, {}, opts(jest.fn()))).rejects.toMatchObject({ status: 0 });
  });
});
