// Raw-body file uploads (contracts/attachments.md): streamed from disk by expo-file-system with the
// file's Content-Length, never read into JS memory, with progress. Sent once: a retry could store
// the file twice.

import { ApiError } from '../../../core/api';
import type { ServerConfig } from '../../../core/ports';

/** The slice of expo-file-system/legacy used here (injected so tests run without native code). */
export interface UploadTaskLike {
  uploadAsync(): Promise<{ status: number; body: string } | undefined | null>;
  cancelAsync(): Promise<void>;
}
export type CreateUploadTask = (
  url: string,
  fileUri: string,
  options: { httpMethod: 'POST'; uploadType: number; headers: Record<string, string> },
  onProgress: (p: { totalBytesSent: number; totalBytesExpectedToSend: number }) => void,
) => UploadTaskLike;

export const BINARY_CONTENT = 0; // FileSystemUploadType.BINARY_CONTENT

export async function uploadRaw<T>(
  server: ServerConfig | null,
  path: string,
  file: { uri: string; mime: string; name: string },
  opts: { timeoutMs: number; onProgress?: (sent: number, total: number) => void; signal?: AbortSignal; headers?: Record<string, string> },
  createTask: CreateUploadTask,
): Promise<T> {
  if (!server) throw new ApiError(0, 'Not connected to a server');
  if (opts.signal?.aborted) throw new ApiError(0, 'cancelled');
  const task = createTask(
    server.baseUrl + path,
    file.uri,
    {
      httpMethod: 'POST',
      uploadType: BINARY_CONTENT,
      headers: {
        ...opts.headers, // the caller's own (e.g. x-clip-sha256); never overriding the ones below
        Authorization: `Bearer ${server.token}`,
        Accept: 'application/json',
        'Content-Type': file.mime, // a hint only: the server sniffs the type
        'x-filename': encodeURIComponent(file.name),
      },
    },
    (p) => opts.onProgress?.(p.totalBytesSent, p.totalBytesExpectedToSend),
  );
  // A timeout or an abort (the attachment was removed) cancels the native task: no bytes keep flowing.
  let ended: 'timed out' | 'cancelled' | null = null;
  const cancel = (why: 'timed out' | 'cancelled') => {
    if (ended) return;
    ended = why;
    void task.cancelAsync();
  };
  const timer = setTimeout(() => cancel('timed out'), opts.timeoutMs);
  const onAbort = () => cancel('cancelled');
  opts.signal?.addEventListener('abort', onAbort);
  let res: { status: number; body: string } | undefined | null;
  try {
    res = await task.uploadAsync();
  } catch (e) {
    throw new ApiError(0, ended ?? (e instanceof Error ? e.message : String(e)));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  if (ended || !res) throw new ApiError(0, ended ?? 'cancelled');
  let payload: unknown = null;
  try {
    payload = JSON.parse(res.body);
  } catch {
    // not JSON: fall through
  }
  if (res.status < 200 || res.status >= 300) {
    const message = (payload as { error?: unknown } | null)?.error;
    throw new ApiError(res.status, typeof message === 'string' ? message : `HTTP ${res.status}`);
  }
  return (payload ?? {}) as T;
}
