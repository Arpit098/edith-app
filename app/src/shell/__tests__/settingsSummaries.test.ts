// Each Settings row's one-line summary, from the feature's own state.

import { updateSummary } from '../../features/app-update/summary';
import { accountsSummary } from '../../features/claude-accounts/summary';
import { initialAccounts } from '../../features/claude-accounts/model';
import { voiceSummary } from '../../features/live-session/summary';
import { liveAlertsSummary } from '../../features/live-status/summary';
import { pushSummary } from '../../features/push/summary';
import { wakewordSummary } from '../../features/wakeword/summary';
import type { AppUpdateState } from '../../features/app-update/model';
import type { PushState } from '../../features/push/model';
import type { VoiceState } from '../../features/live-session/voice';
import type { WakewordState } from '../../features/wakeword/model';
import { linkSummary } from '../SettingsScreen';

describe('settings summaries', () => {
  it('connection', () => {
    expect(linkSummary({ link: 'open', baseUrl: 'http://100.78.124.98:8787' })).toBe('Connected · 100.78.124.98');
    expect(linkSummary({ link: 'offline', baseUrl: 'http://edith:8787' })).toBe('Offline');
    expect(linkSummary({ link: 'unauthorized', baseUrl: null })).toBe('Token rejected');
  });

  it('Claude accounts', () => {
    const accounts = [
      { id: 'a', label: 'Interseqt', email: 'a@x', plan: 'max', active: true },
      { id: 'b', label: 'Personal', email: 'b@x', plan: 'pro', active: false },
    ];
    expect(accountsSummary(initialAccounts)).toBeNull();
    expect(accountsSummary({ ...initialAccounts, loaded: true, accounts })).toBe('2 accounts · Interseqt active');
    expect(accountsSummary({ ...initialAccounts, loaded: true, accounts: accounts.slice(1) })).toBe('1 account');
    expect(accountsSummary({ ...initialAccounts, loaded: true })).toBe('Not signed in');
    expect(accountsSummary({ ...initialAccounts, error: 'offline' })).toBe('Couldn’t load the accounts');
    const running = { run: 'r', target: 'b', previous: 'a', state: 'running' as const, step: 'stopping', detail: null, started: null, ts: null, agents: [] };
    expect(accountsSummary({ ...initialAccounts, loaded: true, accounts, switch: running })).toBe('Switching…');
  });

  it('Push', () => {
    const status: PushState['status'] = { enabled: true, ntfyUrl: 'http://e:2586', mode: 'instant', connected: true, error: null, lastCheckAt: null, batteryUnrestricted: true };
    const s = (patch: Partial<PushState['status']>): PushState => ({ status: { ...status, ...patch }, error: null, fetching: false });
    expect(pushSummary(s({ enabled: false }))).toBe('Off');
    expect(pushSummary(s({}))).toBe('On · Instant');
    expect(pushSummary(s({ connected: false }))).toBe('On · Instant · connecting');
    expect(pushSummary(s({ mode: 'poll', connected: false }))).toBe('On · Every 15 min');
    expect(pushSummary(s({ error: 'refused' }))).toBe('On · Instant · not reaching edith');
  });

  it('Live Alerts', () => {
    expect(liveAlertsSummary(true, true)).toBe('Shows in the pill');
    expect(liveAlertsSummary(true, false)).toBe('Live Updates are off');
    expect(liveAlertsSummary(false, false)).toBe('Ongoing notification');
  });

  it('Voice input', () => {
    const v = (patch: Partial<VoiceState>): VoiceState => ({ available: true, phase: 'idle', elapsedMs: 0, level: 0, error: null, autoSend: false, ...patch }) as VoiceState;
    expect(voiceSummary(v({}))).toBe('Fills the box to edit first');
    expect(voiceSummary(v({ autoSend: true }))).toBe('Sends right after speaking');
    expect(voiceSummary(v({ available: false }))).toBe('Not available');
  });

  it('Wake word', () => {
    const w = (patch: Partial<WakewordState>) => ({ enabled: false, clips: [], ...patch }) as WakewordState;
    expect(wakewordSummary(w({}))).toBe('Off');
    expect(wakewordSummary(w({ enabled: true, clips: [{}, {}] as WakewordState['clips'] }))).toBe('“Hey Edith” on · 2 takes recorded');
  });

  it('Updates', () => {
    const base: AppUpdateState = { installed: { versionName: '1.0', versionCode: 1090 }, ota: null, latest: null, checkedAt: null, checking: false, error: null, otaReady: false, otaId: null, phase: 'idle', received: 0, total: 0, message: null, seen: null, seenLoaded: true, restarting: false };
    const u = (patch: Partial<AppUpdateState>) => updateSummary({ ...base, ...patch });
    expect(u({})).toBe('Build 1090');
    expect(u({ checkedAt: 1 })).toBe('Up to date · build 1090');
    expect(u({ checkedAt: 1, latest: { versionCode: 1095 } as AppUpdateState['latest'] })).toBe('Update available · build 1095');
    expect(u({ checking: true })).toBe('Checking…');
    expect(u({ phase: 'downloading', received: 5, total: 20 })).toBe('Downloading · 25 %');
    expect(u({ otaReady: true, checkedAt: 1 })).toBe('Update ready · used on the next start');
    expect(u({ error: 'offline' })).toBe('Couldn’t check for updates');
    expect(u({ installed: null })).toBeNull();
  });
});
