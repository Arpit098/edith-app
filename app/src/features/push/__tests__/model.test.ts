import type { PushMode, PushReceiver, PushSetup, PushStatus } from '../../../core/ports';
import { fakeContext } from '../../../testing/fakes';
import { createPushModel, defaultNtfyUrl } from '../model';

const TOKEN = 'tk_' + 'a1'.repeat(14) + 'b'; // 29 after tk_

class FakePush implements PushReceiver {
  setup: PushSetup | null = null;
  apis: [string, string][] = [];
  resumed = 0;
  modes: PushMode[] = [];
  refuse = false;
  state: Partial<PushStatus> = {};
  enable(setup: PushSetup) {
    if (this.refuse) return false;
    this.setup = setup;
    return true;
  }
  updateApi(apiUrl: string, apiToken: string) {
    this.apis.push([apiUrl, apiToken]);
  }
  setMode(mode: PushMode) {
    this.modes.push(mode);
    if (this.setup) this.setup = { ...this.setup, mode };
    return true;
  }
  resume() {
    this.resumed++;
    return true;
  }
  disable() {
    this.setup = null;
    this.state = {};
  }
  status(): PushStatus {
    return {
      enabled: this.setup !== null,
      ntfyUrl: this.setup?.ntfyUrl ?? null,
      mode: this.setup?.mode ?? 'instant',
      connected: false,
      error: null,
      lastCheckAt: null,
      batteryUnrestricted: false,
      ...this.state,
    };
  }
  openBatterySettings() {}
}

function setup(configured = true) {
  const ctx = fakeContext();
  if (configured) ctx.transport.configure({ baseUrl: 'http://100.78.124.98:8787', token: 'app-token' });
  const push = new FakePush();
  let asked = 0;
  const ensurePermission = async () => (asked++, true);
  const model = createPushModel({ push, transport: ctx.transport, connection: ctx.connection, ensurePermission });
  const open = () => ctx.connection.store.set((s) => ({ ...s, link: 'open' }));
  return { ctx, push, model, open, asked: () => asked };
}

describe('push model', () => {
  afterEach(() => jest.useRealTimers());

  it('derives the ntfy address from the App API one', () => {
    expect(defaultNtfyUrl('http://100.78.124.98:8787')).toBe('http://100.78.124.98:2586');
    expect(defaultNtfyUrl('http://edith')).toBe('http://edith:2586');
    expect(defaultNtfyUrl(null)).toBe('');
  });

  it('turns on with the phone token and the App API for Allow/Deny, then follows the stream until it connects', () => {
    jest.useFakeTimers();
    const { push, model, asked } = setup();
    expect(model.enable('http://100.78.124.98:2586/', ` ${TOKEN} `)).toBe(true);
    expect(push.setup).toEqual({ ntfyUrl: 'http://100.78.124.98:2586', topic: 'edith', ntfyToken: TOKEN, apiUrl: 'http://100.78.124.98:8787', apiToken: 'app-token', mode: 'instant' });
    expect(asked()).toBe(1);
    expect(model.store.get().status).toMatchObject({ enabled: true, connected: false });
    push.state = { connected: true };
    jest.advanceTimersByTime(1000);
    expect(model.store.get().status.connected).toBe(true);
    expect(jest.getTimerCount()).toBe(0); // connected: no more checks
    model.disable();
    expect(model.store.get().status.enabled).toBe(false);
    model.dispose();
  });

  it('turns on in the 15-minute mode, and switches between the modes', () => {
    jest.useFakeTimers();
    const { push, model } = setup();
    expect(model.enable('http://edith:2586', TOKEN, 'poll')).toBe(true);
    expect(push.setup?.mode).toBe('poll');
    expect(model.store.get().status.mode).toBe('poll');
    model.setMode('instant');
    expect(push.modes).toEqual(['instant']);
    expect(model.store.get().status.mode).toBe('instant');
    model.dispose();
  });

  it('stops checking after 8 s without an answer', () => {
    jest.useFakeTimers();
    const { model } = setup();
    model.enable('http://edith:2586', TOKEN);
    jest.advanceTimersByTime(1000 + 2000 + 4000 + 8000);
    expect(jest.getTimerCount()).toBe(0);
    model.dispose();
  });

  it('refuses a bad address, a bad token, no connection, and says when Android refuses', () => {
    const { push, model } = setup();
    expect(model.enable('edith:2586', TOKEN)).toBe(false);
    expect(model.store.get().error).toContain('http://');
    expect(model.enable('http://edith:2586', 'app-token-by-mistake')).toBe(false);
    expect(model.store.get().error).toContain('ntfy token');
    push.refuse = true;
    expect(model.enable('http://edith:2586', TOKEN)).toBe(false);
    expect(model.store.get().error).toContain('Android');
    expect(setup(false).model.enable('http://edith:2586', TOKEN)).toBe(false);
    model.dispose();
  });

  it('on each reconnect, hands the current App API to the service and resumes it (only while on)', () => {
    const { ctx, push, model, open } = setup();
    open();
    expect([push.resumed, push.apis]).toEqual([0, []]); // off: nothing
    model.enable('http://edith:2586', TOKEN);
    ctx.connection.store.set((s) => ({ ...s, link: 'offline' }));
    ctx.transport.configure({ baseUrl: 'http://100.78.124.98:8787', token: 'new-token' });
    open();
    expect(push.apis).toEqual([['http://100.78.124.98:8787', 'new-token']]);
    expect(push.resumed).toBe(1);
    model.dispose();
  });
});
