import { localEvent } from '../../../core/events';
import type { OngoingStatus, OngoingStatusView } from '../../../core/ports';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createLiveStatus, initialStatus, reduce, viewOf, type LiveStatusState } from '../model';

const run = (events: Parameters<typeof reduce>[1][], from: LiveStatusState = initialStatus) => events.reduce(reduce, from);

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

  it('shows thinking, then the running step with a timer from the oldest run', () => {
    const t0 = ev('turn.started', { ref: 'r1' }, { ts: 1000 });
    let s = run([t0]);
    expect(viewOf(s)).toMatchObject({ title: 'EDITH is thinking', chip: 'Thinking', startedAt: 1_000_000, progress: true, link: 'edith://live' });
    s = run([ev('turn.progress', { ref: 'r1', steps: 3, step: '$ npm test', elapsed: 40 }, { ts: 1040 })], s);
    expect(viewOf(s)).toMatchObject({ title: 'EDITH is working', text: '$ npm test · step 3', chip: 'Working', startedAt: 1_000_000 });
    s = run([ev('turn.started', { ref: 'r2' }, { ts: 1050 })], s);
    expect(viewOf(s)?.title).toBe('EDITH is working (2 tasks)');
    s = run([ev('turn.done', { ref: 'r1' }), ev('turn.stopped', { ref: 'r2' })], s);
    expect(viewOf(s)).toBeNull();
  });

  it('puts an approval first and opens the approvals', () => {
    const s = run([
      ev('turn.started', { ref: 'r1' }),
      ev('permission.request', { id: 'a1', tool: 'Bash', detail: 'rm -rf build' }),
      ev('permission.request', { id: 'a2', tool: 'Write', detail: 'x.ts' }),
    ]);
    expect(viewOf(s)).toEqual({
      title: 'EDITH needs your approval',
      text: 'Bash: rm -rf build (+1 more)',
      chip: 'Approve?',
      startedAt: null,
      progress: false,
      link: 'edith://approvals',
      alert: true,
    });
    const after = run([ev('permission.resolved', { id: 'a1' }), ev('permission.resolved', { id: 'a2', decision: 'gone' })], s);
    expect(viewOf(after)?.chip).toBe('Thinking');
  });

  it('shows listening and speaking from the voice feature', () => {
    expect(viewOf(run([localEvent('app.voice', { state: 'listening' })]))?.chip).toBe('Listening');
    expect(viewOf(run([localEvent('app.voice', { state: 'speaking' })]))?.chip).toBe('Speaking');
    expect(viewOf(run([localEvent('app.voice', { state: 'speaking' }), localEvent('app.voice', { state: 'idle' })]))).toBeNull();
  });

  it('drops runs whose end was missed once the lanes are idle', () => {
    const s = run([ev('turn.started', { ref: 'lost' }), ev('lane.status', { main: 'idle', side: 0, queued: 0 })]);
    expect(viewOf(s)).toBeNull();
    const busy = run([ev('turn.started', { ref: 'r' }), ev('lane.status', { main: 'busy', side: 0, queued: 0 })]);
    expect(viewOf(busy)).not.toBeNull();
  });
});

describe('createLiveStatus', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_800_000_000_000 }));
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
    expect(status.shown.map((v) => v.text)).toEqual(['Working out what to do', 'Edit b.ts · step 3']); // only the newest

    ctx.bus.publish(ev('turn.done', { ref: 'r' }));
    expect(status.cleared).toBe(1);
    expect(ctx.transport.holds).toBe(0);
    jest.advanceTimersByTime(5000);
    expect(status.shown).toHaveLength(2);
    m.dispose();
  });

  it('does not re-post an unchanged view, and asks for permission once', () => {
    const { ctx, status } = setup();
    ctx.bus.publish(ev('permission.request', { id: 'a', tool: 'Bash', detail: 'ls' }));
    ctx.bus.publish(ev('message.user', { text: 'unrelated' }));
    jest.advanceTimersByTime(3000);
    ctx.bus.publish(ev('turn.started', { ref: 'r' })); // the approval still wins: same view
    jest.advanceTimersByTime(3000);
    expect(status.shown).toHaveLength(1);
    ctx.bus.publish(ev('permission.resolved', { id: 'a' }));
    ctx.bus.publish(ev('turn.done', { ref: 'r' }));
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
    expect(status.shown.map((v) => v.chip)).toEqual(['Thinking', 'Working']);
    expect(status.shown.at(-1)).toMatchObject({ text: '$ make', startedAt: 1_800_000_000_000 - 30_000 });
  });
});
