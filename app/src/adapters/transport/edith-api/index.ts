// Adapter: the Transport port over the EDITH App API (HTTP + one WebSocket), reached over Tailscale.

import { AppState } from 'react-native';

import type { RequestOptions, ServerConfig, Transport } from '../../../core/ports';
import { httpRequest, type Fetch } from './http';
import { EventStream, type AppStateLike, type WebSocketFactory, type WebSocketLike } from './stream';

export interface EdithApiOptions {
  fetch?: Fetch;
  connect?: WebSocketFactory;
  appState?: AppStateLike | null;
  requestTimeoutMs?: number;
}

type RNWebSocket = new (url: string, protocols: null, options: { headers: Record<string, string> }) => WebSocketLike;

/** React Native's WebSocket takes headers on Android: the bearer token goes in Authorization. */
const rnConnect: WebSocketFactory = (url, headers) => new (globalThis.WebSocket as unknown as RNWebSocket)(url, null, { headers });

export function createEdithApiTransport(opts: EdithApiOptions = {}): Transport {
  let server: ServerConfig | null = null;
  const http = {
    fetch: opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init)),
    timeoutMs: opts.requestTimeoutMs ?? 10_000,
    attempts: 3,
    backoff: { baseMs: 500, maxMs: 4_000 },
  };
  const stream = new EventStream({
    connect: opts.connect ?? rnConnect,
    appState: opts.appState === null ? undefined : (opts.appState ?? AppState),
    heartbeatMs: 25_000, // the server pings every 25 s too
    connectTimeoutMs: 10_000,
    backgroundGraceMs: 60_000,
    backoff: { baseMs: 1_000, maxMs: 30_000 },
  });
  return {
    configure(config) {
      server = config;
      stream.configure(config);
    },
    request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, ropts: RequestOptions = {}) {
      return httpRequest<T>(server, method, path, body, ropts, http);
    },
    stream: (onEvent, onStatus) => stream.listen({ onEvent, onStatus }),
    reconnect: () => stream.reconnect(),
    authorized: (path) => (server ? { url: server.baseUrl + path, headers: { Authorization: `Bearer ${server.token}` } } : null),
  };
}
