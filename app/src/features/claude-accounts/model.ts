// Claude accounts (contracts/accounts.md): the saved logins on edith, switching EDITH and the coding
// agents to another one, adding one with Claude's own sign-in (link → paste code), renaming and removing.
// Resynced from GET /v1/accounts on app.connected (a switch drops the stream while EDITH restarts, so
// that is also how its progress comes back), and kept current by accounts.switch events. No polling.

import { accountSwitchFrom, ApiError, type AccountSwitch, type Api, type ClaudeAccount } from '../../core/api';
import type { EventBus } from '../../core/events';
import { createStore, type Store } from '../../core/store';

export interface AccountsState {
  accounts: ClaudeAccount[];
  switch: AccountSwitch | null;
  login: { id: string; url: string } | null; // an open sign-in: show its link and the code field
  loaded: boolean;
  busy: 'refresh' | 'switch' | 'login' | 'code' | 'rename' | 'remove' | null;
  error: string | null; // the last action's problem (e.g. why a switch was refused)
}

/** The server's limit on a name (contracts/accounts.md), after trimming. */
export const LABEL_MAX = 40;

/** Why a typed name can't be saved, or null when it can. */
export function labelProblem(label: string): string | null {
  const name = label.trim();
  if (!name) return 'Enter a name.';
  if (name.length > LABEL_MAX) return `A name can be at most ${LABEL_MAX} characters.`;
  return null;
}

export const initialAccounts: AccountsState = { accounts: [], switch: null, login: null, loaded: false, busy: null, error: null };

const STEPS: Record<string, string> = {
  starting: 'Starting',
  stopping: 'Stopping EDITH and the agents',
  saving: 'Saving the current login',
  installing: 'Switching the login',
  starting_agents: 'Starting the agents again',
  starting_edith: 'Starting EDITH again',
  checking: 'Checking everyone is back',
  rolling_back: 'That didn’t work; going back to the previous account',
};

/** One line for a switch: where it is, or how it ended. */
export function switchLine(sw: AccountSwitch, accounts: ClaudeAccount[]): string {
  const name = (id: string | null) => accounts.find((a) => a.id === id)?.label ?? 'the other account';
  switch (sw.state) {
    case 'running':
      return `${STEPS[sw.step ?? ''] ?? 'Switching'}…`;
    case 'done':
      return `Switched to ${name(sw.target)}.${sw.detail ? ` ${sw.detail}.` : ''}`; // e.g. who was at the limit
    case 'rolled_back':
      return `Couldn’t switch, so it went back to ${name(sw.previous)}${sw.detail ? `: ${sw.detail}` : '.'}`;
    default:
      return `The switch failed${sw.detail ? `: ${sw.detail}` : '.'}`;
  }
}

export interface AccountsModel {
  store: Store<AccountsState>;
  refresh(): Promise<void>;
  switchTo(id: string): Promise<void>;
  startLogin(): Promise<string | null>; // the sign-in link
  finishLogin(code: string, label?: string): Promise<boolean>;
  cancelLogin(): Promise<void>;
  /** True once saved; false (with `error` set) when the name or the request was refused. */
  rename(id: string, label: string): Promise<boolean>;
  remove(id: string): Promise<void>;
  dispose(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createAccountsModel(bus: EventBus, api: Api): AccountsModel {
  const store = createStore<AccountsState>(initialAccounts);

  async function act<T>(busy: NonNullable<AccountsState['busy']>, run: () => Promise<T>): Promise<T | undefined> {
    store.set((s) => ({ ...s, busy, error: null }));
    try {
      return await run();
    } catch (e) {
      store.set((s) => ({ ...s, error: message(e) }));
      return undefined;
    } finally {
      store.set((s) => ({ ...s, busy: s.busy === busy ? null : s.busy }));
    }
  }

  async function load() {
    const r = await api.accounts();
    // A finished switch the server no longer lists stays shown; a running one it doesn't know is stale.
    store.set((s) => ({ ...s, accounts: r.accounts, switch: r.switch ?? (s.switch?.state === 'running' ? null : s.switch), login: r.login, loaded: true }));
  }

  const refresh = () => act('refresh', load).then(() => undefined);

  const unsubs = [
    bus.on('app.connected', () => void refresh()),
    bus.on('accounts.switch', (e) => {
      const sw = accountSwitchFrom(e.data);
      if (!sw) return;
      store.set((s) => ({ ...s, switch: sw }));
      if (sw.state !== 'running') void refresh(); // which account is active now
    }),
  ];

  return {
    store,
    refresh,
    async switchTo(id) {
      await act('switch', async () => {
        await api.switchAccount(id);
        // The switch's own events follow (until the stream drops while EDITH restarts).
        store.set((s) => ({ ...s, switch: s.switch?.state === 'running' ? s.switch : { run: '', target: id, previous: null, state: 'running', step: 'starting', detail: null, started: null, ts: null, agents: [] } }));
      });
    },
    async startLogin() {
      const login = await act('login', () => api.startLogin());
      if (!login) return null;
      store.set((s) => ({ ...s, login }));
      return login.url;
    },
    async finishLogin(code, label) {
      const login = store.get().login;
      if (!login) return false;
      const saved = await act('code', async () => {
        try {
          await api.finishLogin(login.id, code.trim(), label?.trim() || undefined);
        } catch (e) {
          // A wrong or expired code ends the sign-in on the server (a malformed one keeps it open).
          if (e instanceof ApiError && e.status === 404) store.set((s) => ({ ...s, login: null }));
          if (e instanceof ApiError && e.status === 400 && !/doesn.t look like/.test(e.message)) store.set((s) => ({ ...s, login: null }));
          throw e;
        }
        store.set((s) => ({ ...s, login: null }));
        await load();
        return true;
      });
      return saved === true;
    },
    async cancelLogin() {
      const login = store.get().login;
      store.set((s) => ({ ...s, login: null, error: null }));
      if (login) await api.cancelLogin(login.id).catch(() => undefined); // it expires on its own anyway
    },
    async rename(id, label) {
      const problem = labelProblem(label);
      if (problem) {
        store.set((s) => ({ ...s, error: problem }));
        return false;
      }
      const saved = await act('rename', async () => {
        const account = await api.renameAccount(id, label.trim());
        if (account) store.set((s) => ({ ...s, accounts: s.accounts.map((a) => (a.id === id ? account : a)) }));
        await load(); // the order follows the new name
        return true;
      });
      return saved === true;
    },
    async remove(id) {
      await act('remove', async () => {
        await api.removeAccount(id);
        await load();
      });
    },
    dispose() {
      unsubs.forEach((u) => u());
    },
  };
}
