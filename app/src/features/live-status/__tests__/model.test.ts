import { localEvent } from '../../../core/events';
import type { OngoingStatus, OngoingStatusView } from '../../../core/ports';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createLiveStatus, IDLE_MS, initialStatus, MAX_HOLD_MS, reduce, viewOf, type LiveStatusState } from '../model';

const T0 = 1_800_000_000_000;
const run = (events: Parameters<typeof reduce>[1][], from: LiveStatusState = initialStatus, now = T0) => events.reduce((s, e) => reduce(s, e, now), from);

class FakeStatus implements OngoingStatus {
  shown: OngoingStatusView[] = [];
  cleared = 0;
  asked = 0;
  show(v: OngoingStatusView) {
    this.shown.push(v);
  }
  clear() {
    this.cleared++;
  }
  async ensurePermission() {
    this.asked++;
    return true;
  }
  canPromote = () => true;
  openPromotionSettings() {}
}

describe('viewOf', () => {
  it('is null when EDITH is idle', () => {
    expect(viewOf(initialStatus)).toBeNull();
  });

  it('shows thinking, running <tool>, thinking again after the result, with a timer from the oldest run', () => {
    let s = run([ev('turn.started', { ref: 'r1', lane: 'main' })]);
    expect(viewOf(s)).toEqual({
      title: 'EDITH is thinking',
      text: 'Working out what to do',
      chip: 'Thinking',
      startedAt: T0,
      progress: true,
      link: 'edith://live',
      keepAlive: true,
    });
    s = run([ev('tool.call', { id: 't1', name: 'Bash', summary: '$ npm test' })], s);
    expect(viewOf(s)).toMatchObject({ title: 'Running Bash', text: '$ npm test', chip: 'Bash' });
    s = run([ev('turn.progress', { ref: 'r1', lane: 'main', steps: 3, step: '$ npm test', elapsed: 40 })], s, T0 + 45_000);
    expect(viewOf(s)).toMatchObject({ text: '$ npm test · step 3', startedAt: T0 + 5_000 }); // re-anchored on the server's elapsed
    s = run([ev('tool.result', { id: 't1', name: 'Bash', ok: true })], s);
    expect(viewOf(s)).toMatchObject({ title: 'EDITH is thinking', text: 'Last: $ npm test · step 3', chip: 'Thinking' });
    s = run([ev('turn.started', { ref: 'r2', lane: 'side' })], s, T0 + 50_000);
    expect(viewOf(s)?.title).toBe('EDITH is thinking · 2 tasks');
    s = run([ev('turn.done', { ref: 'r1' }), ev('turn.progress', { ref: 'r2', lane: 'side', steps: 1, step: 'Read a.ts' })], s, T0 + 60_000);
    expect(viewOf(s)).toMatchObject({ title: 'Running a parallel task', text: 'Read a.ts · step 1', chip: 'Working' });
    s = run([ev('turn.stopped', { ref: 'r2' })], s);
    expect(viewOf(s)).toBeNull();
  });

  it('moves the timer only when the server elapsed differs by a second or more', () => {
    let s = run([ev('turn.started', { ref: 'r', lane: 'main' })]);
    s = run([ev('turn.progress', { ref: 'r', lane: 'main', steps: 1, step: 'x', elapsed: 10.4 })], s, T0 + 10_000);
    expect(viewOf(s)?.startedAt).toBe(T0); // 400 ms off: kept
    s = run([ev('turn.progress', { ref: 'r', lane: 'main', steps: 2, step: 'x', elapsed: 12 })], s, T0 + 10_000);
    expect(viewOf(s)?.startedAt).toBe(T0 - 2_000);
  });

  it('ignores tool events with no main-lane run, and clips a long tool name in the chip', () => {
    expect(viewOf(run([ev('tool.call', { name: 'Bash' })]))).toBeNull();
    const s = run([ev('turn.started', { ref: 'r', lane: 'main' }), ev('tool.call', { name: 'mcp__gmail__search_threads', summary: 'mail' })]);
    expect(viewOf(s)?.chip).toBe('mcp__gmail_…');
  });

  it('puts an approval first, opens the approvals and keeps the turn timer', () => {
    const s = run([
      ev('turn.started', { ref: 'r1' }),
      ev('permission.request', { id: 'a1', tool: 'Bash', detail: 'rm -rf build' }),
      ev('permission.request', { id: 'a2', tool: 'Write', detail: 'x.ts' }),
    ]);
    expect(viewOf(s)).toEqual({
      title: 'Waiting for your approval',
      text: 'Bash: rm -rf build (+1 more)',
      chip: 'Approve?',
      startedAt: T0,
      progress: false,
      link: 'edith://approvals',
      keepAlive: true,
    });
    const after = run([ev('permission.resolved', { id: 'a1' }), ev('permission.resolved', { id: 'a2', decision: 'gone' })], s);
    expect(viewOf(after)?.chip).toBe('Thinking');
  });

  it('shows listening and speaking from the voice feature, without keeping EDITH alive', () => {
    expect(viewOf(run([localEvent('app.voice', { state: 'listening' })]))).toMatchObject({ chip: 'Listening', keepAlive: false });
    expect(viewOf(run([localEvent('app.voice', { state: 'speaking' })]))).toMatchObject({ chip: 'Speaking', keepAlive: false });
    expect(viewOf(run([localEvent('app.voice', { state: 'speaking' }), localEvent('app.voice', { state: 'idle' })]))).toBeNull();
    expect(viewOf(run([ev('turn.started', { ref: 'r' }), localEvent('app.voice', { state: 'speaking' })]))).toMatchObject({ chip: 'Speaking', keepAlive: true });
  });

  it('drops runs whose end was missed once the lanes are idle', () => {
    const s = run([ev('turn.started', { ref: 'lost' }), ev('lane.status', { main: 'idle', side: 0, queued: 0 })]);
    expect(viewOf(s)).toBeNull();
    const busy = run([ev('turn.started', { ref: 'r' }), ev('lane.status', { main: 'busy', side: 0, queued: 0 })]);
    expect(viewOf(busy)).not.toBeNull();
  });
});

describe('createLiveStatus', () => {
  beforeEach(() => jest.useFakeTimers({ now: T0 }));
  afterEach(() => jest.useRealTimers());

  function setup() {
    const ctx = fakeContext();
    const status = new FakeStatus();
    const m = createLiveStatus({ bus: ctx.bus, api: ctx.api, status, transport: ctx.transport });
    return { ctx, status, m };
  }

  it('shows, throttles to one update a second, keeps the stream open, and clears when idle', () => {
    const { ctx, status, m } = setup();
    ctx.bus.publish(ev('turn.started', { ref: 'r' }));
    expect(status.shown.map((v) => v.chip)).toEqual(['Thinking']);
    expect(ctx.transport.holds).toBe(1);
    expect(status.asked).toBe(1);

    ctx.bus.publish(ev('turn.progress', { ref: 'r', steps: 1, step: 'Read a.ts' }));
    ctx.bus.publish(ev('turn.progress', { ref: 'r', steps: 2, step: 'Read b.ts' }));
    ctx.bus.publish(ev('turn.progress', { ref: 'r', steps: 3, step: 'Edit b.ts' }));
    expect(status.shown).toHaveLength(1); // within the second: held back
    jest.advanceTimersByTime(1000);
    expect(status.shown.map((v) => v.text)).toEqual(['Working out what to do', 'Last: Edit b.ts · step 3']); // only the newest

    ctx.bus.publish(ev('turn.done', { ref: 'r' }));
    expect(status.cleared).toBe(1);
    expect(ctx.transport.holds).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(status.shown).toHaveLength(2);
    m.dispose();
  });

  it('never throttles starting or ending the keep-alive', () => {
    const { ctx, status } = setup();
    ctx.bus.publish(localEvent('app.voice', { state: 'speaking' }));
    ctx.bus.publish(ev('turn.started', { ref: 'r' })); // keepAlive turns on: shown at once
    expect(status.shown.map((v) => v.keepAlive)).toEqual([false, true]);
    ctx.bus.publish(ev('turn.done', { ref: 'r' })); // and off again at once
    expect(status.shown.map((v) => v.keepAlive)).toEqual([false, true, false]);
  });

  it('does not re-post an unchanged view, and asks for permission once', () => {
    const { ctx, status } = setup();
    ctx.bus.publish(ev('permission.request', { id: 'a', tool: 'Bash', detail: 'ls' }));
    ctx.bus.publish(ev('permission.request', { id: 'a', tool: 'Bash', detail: 'ls' })); // a duplicate
    ctx.bus.publish(ev('message.user', { text: 'unrelated' }));
    jest.advanceTimersByTime(3000);
    expect(status.shown).toHaveLength(1);
    ctx.bus.publish(ev('permission.resolved', { id: 'a' }));
    ctx.bus.publish(ev('turn.started', { ref: 'r2' }));
    expect(status.asked).toBe(1);
  });

  it('resyncs runs and approvals from the server after a reconnect', async () => {
    const { ctx, status } = setup();
    ctx.transport
      .on('GET /v1/status', { main: 'busy', queued: 0, runs: [{ ref: 'r9', lane: 'main', seconds: 30, step: '$ make' }], tmux: 'running', conversation: true, session: null })
      .on('GET /v1/permissions', { pending: [] });
    ctx.bus.publish(ev('turn.started', { ref: 'stale' })); // its end happened while we were away
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush(); // promises aren't faked
    jest.advanceTimersByTime(1000);
    expect(status.shown).toHaveLength(2);
    expect(status.shown.at(-1)).toMatchObject({ text: 'Last: $ make', startedAt: T0 - 30_000 });
  });

  const statusAnswer = (runs: unknown[]) => ({ main: runs.length ? 'busy' : 'idle', queued: 0, runs, tmux: 'running', conversation: true, session: null });

  it('replays events that arrived while a resync was in flight over its snapshot', async () => {
    const { ctx, status, m } = setup();
    let answer!: (v: unknown) => void;
    ctx.transport.on('GET /v1/status', () => new Promise((r) => (answer = r))).on('GET /v1/permissions', { pending: [] });
    ctx.bus.publish(ev('turn.started', { ref: 'r' }));
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    ctx.bus.publish(ev('turn.done', { ref: 'r' })); // after the snapshot was taken, before it arrives
    answer(statusAnswer([{ ref: 'r', lane: 'main', seconds: 5, step: null }]));
    await flush();
    jest.advanceTimersByTime(1000);
    expect(viewOf(m.state())).toBeNull();
    expect(status.shown.at(-1)?.keepAlive).toBe(true);
    expect(status.cleared).toBe(1);
  });

  it('when quiet for the idle time, asks the server and keeps holding only if it is still busy', async () => {
    const { ctx, status } = setup();
    ctx.transport.on('GET /v1/permissions', { pending: [] });
    ctx.transport.on('GET /v1/status', statusAnswer([{ ref: 'r', lane: 'main', seconds: 600, step: '$ make' }]));
    ctx.bus.publish(ev('turn.started', { ref: 'r' }));
    jest.advanceTimersByTime(IDLE_MS - 1);
    expect(ctx.transport.calls).toHaveLength(0);
    jest.advanceTimersByTime(1);
    await flush();
    expect(status.cleared).toBe(0); // still busy: held, and re-posted
    expect(status.shown.at(-1)).toMatchObject({ keepAlive: true, text: 'Last: $ make' });
    ctx.transport.on('GET /v1/status', () => Promise.reject(new Error('down')));
    jest.advanceTimersByTime(IDLE_MS);
    await flush();
    expect(status.cleared).toBe(1); // unreachable: let go
    expect(ctx.transport.holds).toBe(0);
  });

  it('never holds longer than the maximum, even with events flowing', () => {
    const { ctx, status } = setup();
    ctx.bus.publish(ev('turn.started', { ref: 'r' }));
    for (let t = 0; t < MAX_HOLD_MS; t += IDLE_MS / 2) {
      ctx.bus.publish(ev('turn.progress', { ref: 'r', steps: 1, step: 'x' }));
      jest.advanceTimersByTime(IDLE_MS / 2);
    }
    expect(status.cleared).toBe(1);
    expect(ctx.transport.holds).toBe(0);
  });

  it('re-posts a held status that has not changed for the idle time, renewing the native deadlines', () => {
    const { ctx, status } = setup();
    ctx.bus.publish(ev('turn.started', { ref: 'r' }));
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(IDLE_MS / 4);
      ctx.bus.publish(ev('message.assistant', { text: 'still going' })); // an event, but no change
    }
    expect(status.shown).toHaveLength(2);
    expect(status.shown[1]).toEqual(status.shown[0]);
  });
});