// The notification states the CI emulator job posts and screenshots (.github/workflows/notifications.yml),
// made by the real live-status and notifications models from a scripted turn. The job reads
// scripts/emulator/states.json; this test fails when it is out of date. To refresh it:
//   UPDATE_STATES=1 npx jest src/__tests__/emulator-states.test.ts

import fs from 'fs';
import path from 'path';

import { localEvent, type EdithEvent } from '../core/events';
import type { LocalNotification, Notifier, OngoingStatus, OngoingStatusView } from '../core/ports';
import { createLiveStatus } from '../features/live-status/model';
import { createNotifications } from '../features/notifications/model';
import { ev, fakeContext } from '../testing/fakes';

const FILE = path.resolve(__dirname, '../../scripts/emulator/states.json');
const T0 = 1_800_000_000_000;
// The emulator reaches the runner's mock App API (scripts/emulator/mock-api.py) here.
const MOCK_API = 'http://10.0.2.2:8787';

type State = { name: string; kind: 'status'; payload: OngoingStatusView } | { name: string; kind: 'notify'; payload: LocalNotification } | { name: string; kind: 'clear' };

/** Each step's events go to a fresh pair of models fed the turn so far; the step's state is the last thing posted. */
function states(): State[] {
  const app = { origin: 'app' as const };
  const turn = [ev('turn.started', { ref: 'r1', lane: 'main' }, app)];
  const tool = [ev('tool.call', { id: 't1', name: 'Bash', summary: '$ npm test' }), ev('turn.progress', { ref: 'r1', lane: 'main', steps: 3, step: '$ npm test', elapsed: 42 }, app)];
  const steps: [string, 'status' | 'notify', EdithEvent[]][] = [
    ['status-thinking', 'status', turn],
    ['status-running-tool', 'status', [...turn, ...tool]],
    ['status-approval', 'status', [...turn, ...tool, ev('permission.request', { id: 'p1', tool: 'Bash', detail: 'rm -rf app/build', ref: 'r1', lane: 'main' }, app)]],
    ['status-speaking', 'status', [localEvent('app.voice', { state: 'speaking' })]],
    ['notify-reply', 'notify', [ev('turn.done', { ref: 'r1', lane: 'main', text: 'All 42 tests pass.', display_text: 'All **42** tests pass, and the build is clean.' } as never, app)]],
    ['notify-side-reply', 'notify', [ev('turn.done', { ref: 's1', lane: 'side', text: 'The disk is 41% full (82 GB free).' }, app)]],
    ['notify-reminder', 'notify', [ev('reminder.due', { id: 'ab12', text: 'Renew the domain', every: null, due: 1_800_000_000, late: false })]],
    ['notify-error', 'notify', [ev('turn.failed', { ref: 'r2', reason: 'error', detail: 'Claude exited with code 1', stderr: '' }, app)]],
    ['notify-approval', 'notify', [ev('permission.request', { id: 'p2', tool: 'Bash', detail: 'git push origin notify-island', ref: 'r3', lane: 'main' }, app)]],
  ];
  return steps.map(([name, kind, events]) => {
    const posted: State[] = [];
    const status: OngoingStatus = {
      show: (payload) => posted.push({ name, kind: 'status', payload }),
      clear: () => posted.push({ name, kind: 'clear' }),
      ensurePermission: async () => true,
      canPromote: () => true,
      openPromotionSettings: () => {},
      liveUpdates: true,
      testIsland: () => {},
    };
    const notifier: Notifier = { post: (payload) => posted.push({ name, kind: 'notify', payload }), cancel: () => {}, active: async () => [], ensurePermission: async () => true };
    const ctx = fakeContext();
    ctx.transport.configure({ baseUrl: MOCK_API, token: 'ci-token' });
    const model = kind === 'status' ? createLiveStatus({ bus: ctx.bus, api: ctx.api, status, transport: ctx.transport }) : createNotifications({ bus: ctx.bus, api: ctx.api, notifier, transport: ctx.transport });
    for (const e of events) {
      ctx.bus.publish(e);
      jest.advanceTimersByTime(1000); // past the live status's update throttle
    }
    const last = posted.filter((p) => p.kind === kind).at(-1);
    model.dispose();
    if (!last) throw new Error(`step ${name} posted nothing`);
    return last;
  });
}

describe('emulator states', () => {
  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => jest.useRealTimers());

  it('scripts/emulator/states.json is what the models post', () => {
    const made = `${JSON.stringify({ t0: T0, states: states() }, null, 2)}\n`;
    if (process.env.UPDATE_STATES) fs.writeFileSync(FILE, made);
    expect(fs.readFileSync(FILE, 'utf8')).toBe(made);
  });

  it('covers every live status and every notification channel', () => {
    const all = states();
    expect(all.filter((s) => s.kind === 'status').map((s) => (s as { payload: OngoingStatusView }).payload.chip)).toEqual(['Thinking', 'Bash', 'Approve?', 'Speaking']);
    expect(new Set(all.filter((s) => s.kind === 'notify').map((s) => (s as { payload: LocalNotification }).payload.channel))).toEqual(new Set(['replies', 'reminders', 'errors', 'approvals']));
  });
});
