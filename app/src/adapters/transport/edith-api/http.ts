// HTTP half of the transport: JSON requests with a timeout per attempt, and retries with backoff
// for requests that are safe to repeat.

import { backoffDelay, sleep, type Backoff } from '../../../common/backoff';
import { ApiError, isRetryable } from '../../../core/api';
import type { RequestOptions, ServerConfig } from '../../../core/ports';

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  fetch: Fetch;
  timeoutMs: number;
  /** Total attempts for GET and PATCH. POSTs are sent once: repeating one could run a task twice. */
  attempts: number;
  backoff: Backoff;
}

export async function httpRequest<T>(
  server: ServerConfig | null,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body: unknown,
  opts: RequestOptions,
  http: HttpOptions,
): Promise<T> {
  if (!server) throw new ApiError(0, 'Not connected to a server');
  const attempts = method === 'POST' ? 1 : Math.max(1, http.attempts);
  for (let attempt = 0; ; attempt++) {
    try {
      return await once<T>(server, method, path, body, opts.timeoutMs ?? http.timeoutMs, http.fetch);
    } catch (e) {
      if (!isRetryable(e) || attempt + 1 >= attempts) throw e;
      await sleep(backoffDelay(attempt, http.backoff));
    }
  }
}

async function once<T>(server: ServerConfig, method: string, path: string, body: unknown, timeoutMs: number, fetch: Fetch): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs); // covers the answer's body too
  let res: Response;
  let payload: unknown = null;
  try {
    res = await fetch(server.baseUrl + path, {
      method,
      headers: {
        Authorization: `Bearer ${server.token}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: abort.signal,
    });
    try {
      payload = await res.json();
    } catch {
      if (abort.signal.aborted) throw new Error('aborted');
      // an empty or non-JSON body: go on with null
    }
  } catch (e) {
    throw new ApiError(0, abort.signal.aborted ? 'timed out' : e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const message = (payload as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof message === 'string' ? message : `HTTP ${res.status}`);
  }
  return (payload ?? {}) as T;
}
