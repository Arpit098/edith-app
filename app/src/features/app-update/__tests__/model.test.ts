import { ApiError } from '../../../core/api';
import { localEvent } from '../../../core/events';
import type { AppInstaller, InstallStatus, OtaInfo, OtaUpdates } from '../../../core/ports';
import { fakeContext, flush } from '../../../testing/fakes';
import { apkAvailable, AUTO_CHECK_EVERY_S, createAppUpdateModel } from '../model';

const SHA = 'a'.repeat(64);
const LATEST = {
  versionName: '0.3.0',
  versionCode: 1043,
  sha: 'abc',
  built_at: 1_800_000_000,
  runtimeVersion: 'rv1',
  size: 1000,
  sha256: SHA,
  cert_sha256: '2B:6C',
  notes: 'Settings: updates',
  release_notes: null,
  url: '/v1/app/apk/1043',
};

class FakeInstaller implements AppInstaller {
  versionName = '0.2.0';
  versionCode = 1042;
  allowed = true;
  downloads: { url: string; headers: Record<string, string>; sha256: string }[] = [];
  failures: Error[] = [];
  installed: string[] = [];
  private handler: ((s: InstallStatus, m: string) => void) | null = null;
  async download(req: { url: string; headers: Record<string, string> }, sha256: string, size: number, onProgress: (r: number, t: number) => void) {
    this.downloads.push({ ...req, sha256 });
    const fail = this.failures.shift();
    if (fail) throw fail;
    onProgress(size / 2, size);
    return { path: '/cache/app-updates/x.apk' };
  }
  canInstall = async () => this.allowed;
  openInstallSettings = jest.fn(async () => {});
  install = async (path: string) => {
    this.installed.push(path);
  };
  onStatus(h: (s: InstallStatus, m: string) => void) {
    this.handler = h;
    return () => (this.handler = null);
  }
  clearDownloads = async () => {};
  emit(s: InstallStatus, m = '') {
    this.handler?.(s, m);
  }
}

class FakeOta implements OtaUpdates {
  headers: Record<string, string> | null = null;
  next: boolean | Error = false;
  reloads = 0;
  enabled = true;
  info = (): OtaInfo => ({ enabled: this.enabled, updateId: 'u1', createdAt: 1_800_000_000, embedded: false, rolledBack: false, runtimeVersion: 'rv1' });
  setRequestHeaders(h: Record<string, string>) {
    this.headers = h;
  }
  async fetchUpdate() {
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
  async reload() {
    this.reloads++;
  }
}

function setup(latest: unknown = LATEST) {
  const ctx = fakeContext();
  ctx.transport.configure({ baseUrl: 'http://edith:8787', token: 'tok' });
  ctx.transport.on('GET /v1/app/latest', latest);
  const installer = new FakeInstaller();
  const ota = new FakeOta();
  const notes: string[] = [];
  const slept: number[] = [];
  let clock = 1_800_000_000;
  const m = createAppUpdateModel({
    bus: ctx.bus,
    api: ctx.api,
    transport: ctx.transport,
    installer,
    ota,
    notify: (t) => notes.push(t),
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
    },
    random: () => 1,
  });
  return { ctx, m, installer, ota, notes, slept, tick: (s: number) => (clock += s) };
}

describe('app update model', () => {
  it('on connect: gives expo-updates the token and checks, at most every 6 h', async () => {
    const { ctx, m, ota, notes, tick } = setup();
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    expect(ota.headers).toEqual({ Authorization: 'Bearer tok', 'expo-channel-name': 'main' });
    expect(apkAvailable(m.store.get())).toBe(true);
    expect(notes).toEqual(['EDITH 0.3.0 is available: Settings → Update']);

    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(ctx.transport.calls.filter((c) => c.path === '/v1/app/latest')).toHaveLength(1);
    tick(AUTO_CHECK_EVERY_S);
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(ctx.transport.calls.filter((c) => c.path === '/v1/app/latest')).toHaveLength(2);
    expect(notes).toHaveLength(1); // told once per version
  });

  it('reports no APK, an older APK, and a malformed answer', async () => {
    const none = setup(() => {
      throw new ApiError(404, 'no app build yet');
    });
    await none.m.check();
    expect(none.m.store.get()).toMatchObject({ latest: null, error: null, checking: false });

    const older = setup({ ...LATEST, versionCode: 1042 });
    await older.m.check();
    expect(apkAvailable(older.m.store.get())).toBe(false);

    const bad = setup({ ...LATEST, sha256: 'nope' });
    await bad.m.check();
    expect(bad.m.store.get().error).toMatch(/^App: edith sent a malformed app release/);
  });

  it('tracks OTA bundles, and explains a 401 from the placeholder header', async () => {
    const { m, ota } = setup();
    ota.next = true;
    await m.check();
    expect(m.store.get().otaReady).toBe(true);
    await m.applyOta();
    expect(ota.reloads).toBe(1);

    const second = setup();
    second.ota.next = new Error('HTTP 401 unauthorized');
    await second.m.check();
    expect(second.m.store.get().error).toBe('Code update: not signed in yet; works after the next app start');

    const off = setup();
    off.ota.enabled = false;
    off.ota.next = new Error('must not be called');
    await off.m.check();
    expect(off.m.store.get().error).toBeNull();
  });

  it('downloads with the token, then opens the installer', async () => {
    const { m, installer } = setup();
    await m.check();
    await m.install();
    expect(installer.downloads).toEqual([{ url: 'http://edith:8787/v1/app/apk/1043', headers: { Authorization: 'Bearer tok' }, sha256: SHA }]);
    expect(installer.installed).toEqual(['/cache/app-updates/x.apk']);
    expect(m.store.get()).toMatchObject({ phase: 'installing', received: 500, total: 1000 });

    installer.emit('pending');
    expect(m.store.get()).toMatchObject({ phase: 'installing', message: 'Confirm in Android’s installer' });
    installer.emit('cancelled');
    expect(m.store.get()).toMatchObject({ phase: 'idle', message: 'Install cancelled' });
    installer.emit('incompatible', 'INSTALL_FAILED_UPDATE_INCOMPATIBLE');
    expect(m.store.get().phase).toBe('failed');
    expect(m.store.get().message).toMatch(/different key.*INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
  });

  it('asks for the install permission first', async () => {
    const { m, installer } = setup();
    installer.allowed = false;
    await m.check();
    await m.install();
    expect(m.store.get().phase).toBe('needs-permission');
    expect(installer.downloads).toHaveLength(0);
    await m.allowInstalls();
    expect(installer.openInstallSettings).toHaveBeenCalled();
    expect(m.store.get().phase).toBe('idle');
  });

  it('retries network errors and 502/503/504 with jittered backoff, resuming', async () => {
    const flaky = setup();
    await flaky.m.check();
    flaky.installer.failures = [new ApiError(0, 'timeout'), new ApiError(503, 'busy')];
    await flaky.m.install();
    expect(flaky.installer.downloads).toHaveLength(3);
    expect(flaky.installer.installed).toHaveLength(1);
    expect(flaky.slept).toEqual([2000, 4000]); // backoffDelay with random() = 1: base, then doubled

    const giveUp = setup();
    await giveUp.m.check();
    giveUp.installer.failures = [new ApiError(0, 'a'), new ApiError(0, 'b'), new ApiError(0, 'c')];
    await giveUp.m.install();
    expect(giveUp.m.store.get()).toMatchObject({ phase: 'failed', message: 'Download failed: c' });
  });

  it('does not retry what retrying cannot fix', async () => {
    const gone = setup();
    await gone.m.check();
    gone.installer.failures = [new ApiError(404, 'not offered')];
    await gone.m.install();
    expect(gone.installer.downloads).toHaveLength(1);
    expect(gone.m.store.get()).toMatchObject({ phase: 'failed', message: 'Download failed: not offered' });

    const odd = setup();
    await odd.m.check();
    odd.installer.failures = [new Error('disk full')]; // not an ApiError: no retry
    await odd.m.install();
    expect(odd.installer.downloads).toHaveLength(1);

    const tampered = setup();
    await tampered.m.check();
    tampered.installer.failures = [new Error('SHA256_MISMATCH: deleted')];
    await tampered.m.install();
    expect(tampered.installer.downloads).toHaveLength(1);
    expect(tampered.m.store.get().message).toBe('The download didn’t match its SHA-256 and was deleted');
    expect(tampered.installer.installed).toHaveLength(0);
  });

  it('does nothing without an update or while one is running', async () => {
    const { m, installer } = setup({ ...LATEST, versionCode: 1000 });
    await m.check();
    await m.install();
    expect(installer.downloads).toHaveLength(0);
    m.dispose();
  });
});
