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
      const json = body === undefined ? undefined : { data: JSON.stringify(body), contentType: 'application/json' };
      return await once<T>(server, method, path, json, opts.timeoutMs ?? http.timeoutMs, http.fetch);
    } catch (e) {
      if (!isRetryable(e) || attempt + 1 >= attempts) throw e;
      await sleep(backoffDelay(attempt, http.backoff));
    }
  }
}

/**
 * A multipart file upload (e.g. audio to /v1/stt). Sent once: an upload that reached the server
 * may already be working, and repeating it would cost whisper twice.
 */
export async function httpUpload<T>(
  server: ServerConfig | null,
  path: string,
  file: { uri: string; mime: string; name: string },
  field: string,
  timeoutMs: number,
  fetch: Fetch,
): Promise<T> {
  if (!server) throw new ApiError(0, 'Not connected to a server');
  const form = new FormData();
  // React Native's FormData streams a file given as {uri, type, name}; the boundary header is set by fetch.
  form.append(field, { uri: file.uri, type: file.mime, name: file.name } as unknown as Blob);
  return once<T>(server, 'POST', path, { data: form }, timeoutMs, fetch);
}

type Body = { data: string | FormData; contentType?: string };

async function once<T>(server: ServerConfig, method: string, path: string, body: Body | undefined, timeoutMs: number, fetch: Fetch): Promise<T> {
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
        ...(body?.contentType ? { 'Content-Type': body.contentType } : {}),
      },
      body: body?.data,
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
