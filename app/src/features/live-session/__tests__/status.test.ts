import { statusDetailsFrom, type StatusDetails } from '../../../core/api';
import { ev, fakeContext } from '../../../testing/fakes';
import { createStore } from '../../../core/store';
import { initialLive, reduce, type LiveState } from '../model';
import { DETAILS } from './details';
import { agentChip, barSummary, contextUsage, detailsLabel, formatAgo, formatElapsed, formatTokens, formatUptime, mainRun, pollDetails, toolName, turnSince, nextTurnStart, trackTurnStart } from '../status';


const run = (events: Parameters<typeof reduce>[1][], from: LiveState = initialLive) => events.reduce(reduce, from);

describe('barSummary', () => {
  it('is idle with nothing running', () => {
    expect(barSummary(initialLive)).toEqual({ state: 'idle', tone: 'idle', label: 'Idle', counts: '', detail: null });
  });

  it('follows the main lane through a turn', () => {
    // The pill's detail is the step running, else the latest prompt; never the session title (Arpit's 13R).
    let s = run([
      ev('session.changed', { session_id: 's1', title: 'you are aware of the 3 agents working on the server?', source: 'resume' }),
      ev('message.user', { text: 'run the tests' }, { origin: 'app' }),
      ev('turn.started', { ref: 'r1', lane: 'main' }),
    ]);
    expect(barSummary(s)).toMatchObject({ state: 'thinking', tone: 'busy', label: 'Thinking', detail: 'run the tests' });
    s = reduce(s, ev('tool.call', { id: 't1', name: 'Bash', summary: '$ npm test' }));
    expect(barSummary(s)).toMatchObject({ state: 'tool', label: 'Running Bash', detail: '$ npm test' });
    s = reduce(s, ev('tool.result', { id: 't1', name: 'Bash', ok: true, summary: '' }));
    expect(barSummary(s)).toMatchObject({ label: 'Thinking', detail: 'run the tests' });
    s = run([ev('turn.done', { ref: 'r1', lane: 'main', text: 'ok' }), ev('lane.status', { main: 'idle', side: 0, queued: 0 })], s);
    expect(barSummary(s).state).toBe('idle');
  });

  it('counts parallel lanes, the queue and approvals', () => {
    const s = run([
      ev('turn.started', { ref: 'r1', lane: 'main' }),
      ev('turn.started', { ref: 's1', lane: 'side' }),
      ev('lane.status', { main: 'busy', side: 1, queued: 2 }),
      ev('permission.request', { id: 'ab', tool: 'Bash', detail: 'rm x' }),
    ]);
    expect(barSummary(s)).toMatchObject({ state: 'waiting_approval', tone: 'approval', label: 'Waiting for approval', counts: '1 parallel · 2 queued · 1 approval' });
  });
});

describe('formatting', () => {
  it('names tools from step summaries', () => {
    expect(toolName('$ npm test')).toBe('Bash');
    expect(toolName('Read: /a/b.py')).toBe('Read');
    expect(toolName('mcp__telegram__reply')).toBe('mcp__telegram__reply');
    expect(toolName('x'.repeat(40))).toHaveLength(24);
  });

  it('formats times and sizes', () => {
    expect([formatElapsed(42), formatElapsed(725), formatElapsed(3723), formatElapsed(-3)]).toEqual(['0:42', '12:05', '1:02:03', '0:00']);
    expect([formatUptime(40), formatUptime(720), formatUptime(18_720), formatUptime(273_600)]).toEqual(['40s', '12m', '5h 12m', '3d 4h']);
    expect([formatTokens(950), formatTokens(320_562), formatTokens(1_250_000), formatTokens(1_000_000)]).toEqual(['950', '321k', '1.25M', '1M']);
  });

  it('says how long ago in plain words', () => {
    expect([formatAgo(10), formatAgo(90), formatAgo(180), formatAgo(3600), formatAgo(7500), formatAgo(3 * 86400 + 5)]).toEqual([
      'just now', '2 min ago', '3 min ago', '1 h ago', '2 h 5 min ago', '3 d ago',
    ]);
  });

  it('shows the context against the smallest window that fits it, with how full it is', () => {
    expect(contextUsage(120_000)).toEqual({ text: '120k of 200k', fraction: 0.6 });
    expect(contextUsage(320_562)).toMatchObject({ text: '321k of 1M' });
    expect(contextUsage(1_200_000)).toEqual({ text: '1.2M tokens', fraction: null }); // past every known window: no bar
  });

  it("gives each coding agent a chip for its state", () => {
    const [busy, blocked] = statusDetailsFrom(DETAILS).agents;
    expect(agentChip(busy!)).toEqual({ label: 'Busy', tone: 'busy' });
    expect(agentChip(blocked!)).toEqual({ label: 'Needs approval', tone: 'warn' });
    expect(agentChip({ ...busy!, state: 'idle' })).toEqual({ label: 'Idle', tone: 'idle' });
    expect(agentChip({ ...busy!, state: 'blocked', blocked: 'usage_limit' })).toEqual({ label: 'Usage limit', tone: 'danger' });
  });

  it('labels the server state', () => {
    const d = statusDetailsFrom(DETAILS);
    expect(detailsLabel(d.edith)).toBe('Running Bash');
    expect(detailsLabel({ ...d.edith, state: 'waiting_approval' })).toBe('Waiting for approval (Bash)');
    expect(detailsLabel({ ...d.edith, state: 'idle' })).toBe('Idle');
  });
});

describe('statusDetailsFrom', () => {
  it('reads the contract shape', () => {
    const d = statusDetailsFrom(DETAILS);
    expect(d.edith).toEqual(DETAILS.edith);
    expect(d.lanes.side[0]).toEqual({ ref: 's9', seconds: 12, step: null, summary: 'check the disk' });
    expect(d.agents[1]).toMatchObject({ state: 'blocked', blocked: 'permission', last: null });
    expect(d.session?.context_tokens).toBe(320_562);
  });

  it('tolerates missing and odd fields', () => {
    const d = statusDetailsFrom({ edith: { state: 'dancing' }, agents: [null, { name: 'x', state: 'weird' }], session: null });
    expect(d.edith.state).toBe('idle');
    expect(d.edith.tmux).toBe('down');
    expect(d.agents).toEqual([{ name: 'x', dir: '', branch: null, state: 'idle', blocked: null, last: null }]);
    expect(d.session).toBeNull();
    expect(d.lanes).toEqual({ side: [], max_side: 0, queued: 0, approvals: 0 });
  });

  it('is fetched from /v1/status/details', async () => {
    const ctx = fakeContext();
    ctx.transport.on('GET /v1/status/details', DETAILS);
    expect((await ctx.api.statusDetails()).server.tag).toBe('p1-live-7');
  });
});

describe("mainRun and turnSince (the header chip's timer)", () => {
  it('takes the main run and its elapsed seconds', () => {
    expect(mainRun(initialLive)).toEqual({ ref: null, elapsed: null });
    const s = run([ev('turn.started', { ref: 's1', lane: 'side' }), ev('turn.progress', { ref: 'r1', lane: 'main', steps: 2, step: '$ ls', elapsed: 42 })]);
    expect(mainRun(s)).toEqual({ ref: 'r1', elapsed: 42 });
  });
  it("counts back from the server's elapsed, else from when work began here", () => {
    expect(turnSince(42, 5000, 4990)).toBe(4958); // opened mid-turn: the whole turn so far, not since the app saw it
    expect(turnSince(0, 5000, 4990)).toBe(4990); // turn.started carries no elapsed
    expect(turnSince(null, 5000, 4990)).toBe(4990);
  });
});

describe('pollDetails', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fetches now, then every interval after each answer, and stops', async () => {
    const fetch = jest.fn().mockResolvedValue(statusDetailsFrom(DETAILS));
    const results: unknown[] = [];
    const stop = pollDetails(fetch, (r) => results.push(r), 10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    stop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a slow fetch, reports errors, and drops answers after stop', async () => {
    let resolve!: (d: StatusDetails) => void;
    const fetch = jest.fn(() => new Promise<StatusDetails>((r) => (resolve = r)));
    const results: unknown[] = [];
    const stop = pollDetails(fetch, (r) => results.push(r), 10_000);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1); // still waiting for the first answer
    stop();
    resolve(statusDetailsFrom(DETAILS));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(results).toEqual([]);

    const failing = jest.fn().mockRejectedValue(new Error('offline'));
    const errors: unknown[] = [];
    const stop2 = pollDetails(failing, (r) => errors.push(r), 10_000);
    await jest.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([{ error: 'offline' }]);
    stop2();
  });
});

describe('the shared turn start', () => {
  it('is null idle, set when a run first appears (no elapsed: now), kept while it runs, re-anchored on elapsed, new on a new ref', () => {
    expect(nextTurnStart(initialLive, 100)).toBeNull();
    let s = run([ev('turn.started', { ref: 'r1', lane: 'main' })]);
    const first = nextTurnStart(s, 100)!;
    expect(first).toEqual({ ref: 'r1', elapsed: 0, at: 100 }); // turn.started carries no elapsed: counted from now
    s = { ...s, turnStart: first };
    expect(nextTurnStart(s, 130)).toBe(first); // same run, nothing new: the same object
    s = run([ev('turn.progress', { ref: 'r1', lane: 'main', steps: 1, step: '$ ls', elapsed: 40 })], s);
    expect(nextTurnStart(s, 150)).toEqual({ ref: 'r1', elapsed: 40, at: 110 });
    s = run([ev('turn.done', { ref: 'r1', lane: 'main', text: 'ok' }), ev('turn.started', { ref: 'r2', lane: 'main' })], s);
    expect(nextTurnStart(s, 200)).toEqual({ ref: 'r2', elapsed: 0, at: 200 });
  });

  it('busy before any run is seen, then the run appears: a fresh start', () => {
    let s = run([ev('lane.status', { main: 'busy', side: 0, queued: 0 })]);
    s = { ...s, turnStart: nextTurnStart(s, 10) };
    expect(s.turnStart).toEqual({ ref: null, elapsed: null, at: 10 }); // run.elapsed null: no run yet
    s = { ...s, turnStart: nextTurnStart(s, 11) };
    expect(s.turnStart!.at).toBe(10); // kept
    s = run([ev('turn.started', { ref: 'r1', lane: 'main' })], s);
    expect(nextTurnStart(s, 12)).toEqual({ ref: 'r1', elapsed: 0, at: 12 });
  });

  it('trackTurnStart keeps the store current and stops on unsubscribe', () => {
    let clock = 1000;
    const store = createStore(initialLive);
    const stop = trackTurnStart(store, () => clock);
    store.set((s) => reduce(s, ev('turn.started', { ref: 'r1', lane: 'main' })));
    expect(store.get().turnStart).toEqual({ ref: 'r1', elapsed: 0, at: 1000 });
    clock = 1020;
    store.set((s) => reduce(s, ev('tool.call', { id: 't1', name: 'Bash', summary: '$ ls' })));
    expect(store.get().turnStart!.at).toBe(1000); // unchanged by other events
    store.set((s) => [ev('turn.done', { ref: 'r1', lane: 'main', text: 'ok' }), ev('lane.status', { main: 'idle', side: 0, queued: 0 })].reduce(reduce, s));
    expect(store.get().turnStart).toBeNull();
    stop();
    store.set((s) => reduce(s, ev('turn.started', { ref: 'r2', lane: 'main' })));
    expect(store.get().turnStart).toBeNull();
  });
});
