// Push while the app is closed (contracts/push.md): turns the native push service on and off, keeps
// its App API address and token in step with the connection (for Allow/Deny), and reports how it's
// doing. The service itself runs natively (ports.push); this holds no tokens beyond handing them over.

import type { Connection } from '../../core/connection';
import type { AppVisibility, PushReceiver, PushStatus, Transport } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

export const NTFY_PORT = 2586; // deploy/ntfy/server.yml
export const TOPIC = 'edith';
/** After turning it on, the stream's first answer is read again at 1, 2, 4 and 8 s (no native event for it). */
const CHECKS_MS = [1000, 2000, 4000, 8000];

export interface PushState {
  status: PushStatus;
  error: string | null; // a refused setup, shown under the form
}

const OFF: PushStatus = { enabled: false, ntfyUrl: null, connected: false, error: null, batteryUnrestricted: false };

/** edith's ntfy: the App API's host on ntfy's port (http://100.78.124.98:8787 -> http://100.78.124.98:2586). */
export function defaultNtfyUrl(apiBaseUrl: string | null): string {
  const m = apiBaseUrl?.match(/^(https?:\/\/[^/:]+)/i);
  return m ? `${m[1]!.replace(/^https:/i, 'http:')}:${NTFY_PORT}` : '';
}

/** "Bearer <token>" from the transport's auth headers -> the App API base URL and token. */
function apiAuth(transport: Transport): { apiUrl: string; apiToken: string } | null {
  const auth = transport.authorized('');
  const token = auth?.headers.Authorization?.replace(/^Bearer\s+/i, '');
  return auth && token ? { apiUrl: auth.url, apiToken: token } : null;
}

export interface PushModel {
  store: Store<PushState>;
  /** Turn pushes on with the phone's ntfy token. False (and `error` set) when the setup is refused. */
  enable(ntfyUrl: string, ntfyToken: string): boolean;
  disable(): void;
  refresh(): void;
  openBatterySettings(): void;
  dispose(): void;
}

export function createPushModel(deps: {
  push: PushReceiver;
  transport: Transport;
  connection: Connection;
  visibility?: AppVisibility;
  ensurePermission?: () => Promise<boolean>; // Android 13+: pushes show as notifications
}): PushModel {
  const { push, transport, connection, visibility } = deps;
  const store = createStore<PushState>({ status: OFF, error: null });
  let checks: ReturnType<typeof setTimeout> | null = null;

  const refresh = () => store.set((s) => ({ ...s, status: push.status() }));

  function stopChecks() {
    if (checks) clearTimeout(checks);
    checks = null;
  }

  function check(i: number) {
    refresh();
    const { status } = store.get();
    if (!status.enabled || status.connected || status.error || i >= CHECKS_MS.length) return;
    checks = setTimeout(() => check(i + 1), CHECKS_MS[i]);
  }

  /** The connection is open: the service runs (Android lets it start while the app is in front) with this API. */
  function sync() {
    if (connection.store.get().link !== 'open' || !push.status().enabled) return;
    const auth = apiAuth(transport);
    if (auth) push.updateApi(auth.apiUrl, auth.apiToken);
    push.resume();
    refresh();
  }

  refresh();
  sync();
  let link = connection.store.get().link;
  const offConnection = connection.store.subscribe(() => {
    const next = connection.store.get().link;
    if (next !== link && next === 'open') sync();
    link = next;
  });
  const offVisibility = visibility?.onChange((active) => active && refresh());

  return {
    store,
    enable(ntfyUrl, ntfyToken) {
      const url = ntfyUrl.trim().replace(/\/+$/, '');
      const token = ntfyToken.trim();
      const auth = apiAuth(transport);
      let error: string | null = null;
      if (!/^https?:\/\/[^/\s]+$/i.test(url)) error = 'Enter the push server as http://<edith’s address>:2586.';
      else if (!/^tk_[A-Za-z0-9]{29}$/.test(token)) error = 'That isn’t an ntfy token (tk_ and 29 letters or digits): use the phone token from edith.';
      else if (!auth) error = 'Connect to edith first: Allow and Deny on pushes use that connection.';
      if (error || !auth) {
        store.set((s) => ({ ...s, error }));
        return false;
      }
      void deps.ensurePermission?.();
      const started = push.enable({ ntfyUrl: url, topic: TOPIC, ntfyToken: token, ...auth });
      store.set((s) => ({ ...s, error: started ? null : 'Android didn’t let the push service start. Open EDITH again and retry.' }));
      stopChecks();
      check(0);
      return started;
    },
    disable() {
      stopChecks();
      push.disable();
      store.set({ status: push.status(), error: null });
    },
    refresh,
    openBatterySettings: () => push.openBatterySettings(),
    dispose() {
      stopChecks();
      offConnection();
      offVisibility?.();
    },
  };
}
