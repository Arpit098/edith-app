// Test doubles for the ports (used by jest only; nothing in the app imports this folder).

import { ApiError, createApi } from '../core/api';
import { Connection } from '../core/connection';
import { EventBus, type EdithEvent, type EventDataMap, type EventType } from '../core/events';
import type { FeatureContext } from '../core/feature';
import type { SecureStorage, ServerConfig, StreamStatus, Transport } from '../core/ports';

type Handler = (body: unknown) => unknown;

export class FakeTransport implements Transport {
  config: ServerConfig | null = null;
  calls: { method: string; path: string; body: unknown }[] = [];
  reconnects = 0;
  private routes = new Map<string, Handler>();
  private listeners = new Set<{ onEvent: (e: EdithEvent) => void; onStatus?: (s: StreamStatus) => void }>();

  /** Answer `METHOD /path` with a value, or with what the function returns (or throws). */
  on(route: string, answer: unknown): this {
    this.routes.set(route, typeof answer === 'function' ? (answer as Handler) : () => answer);
    return this;
  }

  configure(server: ServerConfig | null): void {
    this.config = server;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    const handler = this.routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`FakeTransport: no answer for ${method} ${path}`);
    return handler(body) as T;
  }

  stream(onEvent: (e: EdithEvent) => void, onStatus?: (s: StreamStatus) => void): () => void {
    const l = { onEvent, onStatus };
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  reconnect(): void {
    this.reconnects++;
  }

  uploads: { path: string; file: { uri: string; mime: string; name: string }; field: string; headers?: Record<string, string> }[] = [];
  async upload<T>(path: string, file: { uri: string; mime: string; name: string }, opts: { field?: string } = {}): Promise<T> {
    this.uploads.push({ path, file, field: opts.field ?? 'file' });
    const handler = this.routes.get(`UPLOAD ${path}`);
    if (!handler) throw new Error(`FakeTransport: no answer for UPLOAD ${path}`);
    return handler(file) as T;
  }

  holds = 0;
  holdOpen() {
    this.holds++;
    let released = false;
    return () => {
      if (!released) this.holds--;
      released = true;
    };
  }

  async uploadRaw<T>(
    path: string,
    file: { uri: string; mime: string; name: string },
    opts: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal; headers?: Record<string, string> } = {},
  ): Promise<T> {
    this.uploads.push({ path, file, field: 'raw', headers: opts.headers });
    const handler = this.routes.get(`UPLOAD ${path}`);
    if (!handler) throw new Error(`FakeTransport: no answer for UPLOAD ${path}`);
    opts.onProgress?.(50, 100);
    const { signal } = opts;
    if (!signal) return handler(file) as T;
    // Like the real one: an abort cancels at once, whatever the server would have answered.
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        this.cancelledUploads++;
        reject(new ApiError(0, 'cancelled'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve()
        .then(() => handler(file) as T)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  cancelledUploads = 0;

  authorized(path: string) {
    return this.config ? { url: this.config.baseUrl + path, headers: { Authorization: `Bearer ${this.config.token}` } } : null;
  }

  get streaming(): number {
    return this.listeners.size;
  }

  emit(event: EdithEvent): void {
    for (const l of [...this.listeners]) l.onEvent(event);
  }

  status(status: Partial<StreamStatus> & Pick<StreamStatus, 'state'>): void {
    for (const l of [...this.listeners]) l.onStatus?.({ retryInMs: null, error: null, ...status });
  }
}

export class MemoryStorage implements SecureStorage {
  data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async remove(key: string) {
    this.data.delete(key);
  }
}

/** A server event as it arrives on the stream. */
export function ev<K extends EventType>(type: K, data: Partial<EventDataMap[K]>, extra: Partial<EdithEvent> = {}): EdithEvent {
  return { type, ts: 1_800_000_000, session_id: 's1', origin: 'system', data: data as Record<string, unknown>, ...extra };
}

export function fakeContext(transport = new FakeTransport()): FeatureContext & { transport: FakeTransport } {
  const bus = new EventBus();
  const storage = new MemoryStorage();
  return {
    bus,
    transport,
    ports: { transport, storage },
    api: createApi(transport),
    connection: new Connection(transport, storage, bus),
  };
}

/** Let pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}
