import { ApiError } from '../../../core/api';
import { localEvent } from '../../../core/events';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createAccountsModel, switchLine } from '../model';

const ACCOUNTS = [
  { id: 'aaaa1111', label: 'Personal', email: 'me@example.com', plan: 'max', active: true },
  { id: 'bbbb2222', label: 'Work', email: 'work@example.com', plan: 'pro', active: false },
];

function setup(list: Record<string, unknown> = { accounts: ACCOUNTS, switch: null, login: null }) {
  const ctx = fakeContext();
  ctx.transport.on('GET /v1/accounts', () => list);
  const model = createAccountsModel(ctx.bus, ctx.api);
  return { ctx, model, t: ctx.transport, list };
}

describe('claude accounts', () => {
  it('loads on connect, and again after reconnecting mid-switch', async () => {
    const { ctx, model, list } = setup();
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    expect(model.store.get().accounts.map((a) => [a.label, a.active])).toEqual([['Personal', true], ['Work', false]]);
    expect(model.store.get().loaded).toBe(true);

    // The stream dropped while EDITH restarted; the switch is still running on the server.
    list.switch = { run: 'r1', target: 'bbbb2222', previous: 'aaaa1111', state: 'running', step: 'starting_edith', agents: ['edith-dev'], unit: 'x' };
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(switchLine(model.store.get().switch!, model.store.get().accounts)).toBe('Starting EDITH again…');
  });

  it('switches, follows the events and reloads at the end', async () => {
    const { ctx, model, t, list } = setup();
    await model.refresh();
    t.on('POST /v1/accounts/bbbb2222/switch', { status: 'switching', run: 'r1' });
    await model.switchTo('bbbb2222');
    expect(model.store.get().switch).toMatchObject({ state: 'running', step: 'starting' });

    ctx.bus.publish(ev('accounts.switch', { run: 'r1', target: 'bbbb2222', previous: 'aaaa1111', state: 'running', step: 'stopping', agents: ['edith-dev'] }));
    expect(switchLine(model.store.get().switch!, ACCOUNTS)).toBe('Stopping EDITH and the agents…');

    list.accounts = ACCOUNTS.map((a) => ({ ...a, active: !a.active }));
    ctx.bus.publish(ev('accounts.switch', { run: 'r1', target: 'bbbb2222', previous: 'aaaa1111', state: 'done', step: 'checking' }));
    await flush();
    const s = model.store.get();
    expect(switchLine(s.switch!, s.accounts)).toBe('Switched to Work.');
    expect(s.accounts.find((a) => a.active)?.label).toBe('Work');
  });

  it('shows why a switch was refused', async () => {
    const { model, t } = setup();
    await model.refresh();
    t.on('POST /v1/accounts/bbbb2222/switch', () => {
      throw new ApiError(409, "Can't switch while edith-dev is busy");
    });
    await model.switchTo('bbbb2222');
    expect(model.store.get()).toMatchObject({ error: "Can't switch while edith-dev is busy", switch: null, busy: null });
  });

  it('describes a rollback and a failure', () => {
    const base = { run: 'r', target: 'bbbb2222', previous: 'aaaa1111', step: 'checking', started: 1, ts: 2, agents: [] };
    expect(switchLine({ ...base, state: 'rolled_back', detail: "edith-dev's Claude didn't come back up" }, ACCOUNTS)).toBe(
      "Couldn’t switch, so it went back to Personal: edith-dev's Claude didn't come back up",
    );
    expect(switchLine({ ...base, state: 'failed', detail: null }, ACCOUNTS)).toBe('The switch failed.');
  });

  it('adds an account: link, then the pasted code', async () => {
    const { model, t, list } = setup();
    await model.refresh();
    t.on('POST /v1/accounts/login', { id: 'l1', url: 'https://claude.com/cai/oauth/authorize?x=1' });
    expect(await model.startLogin()).toBe('https://claude.com/cai/oauth/authorize?x=1');
    expect(model.store.get().login).toEqual({ id: 'l1', url: 'https://claude.com/cai/oauth/authorize?x=1' });

    t.on('POST /v1/accounts/login/l1', (body: unknown) => {
      expect(body).toEqual({ code: 'abc#def', label: 'Spare' });
      const spare = { id: 'cccc3333', label: 'Spare', email: 's@example.com', plan: 'pro', active: false };
      list.accounts = [...ACCOUNTS, spare];
      return { account: spare };
    });
    expect(await model.finishLogin(' abc#def ', ' Spare ')).toBe(true);
    expect(model.store.get().login).toBeNull();
    expect(model.store.get().accounts).toHaveLength(3);
  });

  it('a wrong code ends the sign-in; a malformed one keeps it open', async () => {
    const { model, t } = setup();
    t.on('POST /v1/accounts/login', { id: 'l1', url: 'https://x/oauth/authorize?y' });
    await model.startLogin();
    t.on('POST /v1/accounts/login/l1', () => {
      throw new ApiError(400, "that doesn't look like a sign-in code");
    });
    expect(await model.finishLogin('nope nope')).toBe(false);
    expect(model.store.get().login).not.toBeNull();
    t.on('POST /v1/accounts/login/l1', () => {
      throw new ApiError(400, "Login failed: That code wasn't accepted.");
    });
    expect(await model.finishLogin('abc#def')).toBe(false);
    expect(model.store.get()).toMatchObject({ login: null, error: "Login failed: That code wasn't accepted." });
  });

  it('cancels a sign-in and removes an account', async () => {
    const { model, t, list } = setup();
    t.on('POST /v1/accounts/login', { id: 'l1', url: 'https://x/oauth/authorize?y' });
    t.on('DELETE /v1/accounts/login/l1', { cancelled: true });
    await model.startLogin();
    await model.cancelLogin();
    expect(model.store.get().login).toBeNull();
    expect(t.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/accounts/login/l1')).toBe(true);

    t.on('DELETE /v1/accounts/bbbb2222', () => {
      list.accounts = [ACCOUNTS[0]!];
      return { removed: 'bbbb2222' };
    });
    await model.remove('bbbb2222');
    expect(model.store.get().accounts.map((a) => a.id)).toEqual(['aaaa1111']);
  });

  it('never keeps unknown fields from the wire', async () => {
    const { model } = setup({ accounts: [{ ...ACCOUNTS[0], token: 'sk-ant-x' }], switch: { state: 'weird' }, login: null });
    await model.refresh();
    expect(Object.keys(model.store.get().accounts[0]!)).toEqual(['id', 'label', 'email', 'plan', 'active']);
    expect(model.store.get().switch).toBeNull();
  });
});
