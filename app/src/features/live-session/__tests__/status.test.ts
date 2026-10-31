import { statusDetailsFrom, type StatusDetails } from '../../../core/api';
import { ev, fakeContext } from '../../../testing/fakes';
import { initialLive, reduce, type LiveState } from '../model';
import { DETAILS } from './details';
import { ago, barSummary, contextShare, detailsLabel, formatElapsed, formatTokens, formatUptime, mainRun, pollDetails, toolName, turnSince } from '../status';


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
    expect(d.session?.context_max).toBeNull(); // optional: not sent today
    expect(statusDetailsFrom({ ...DETAILS, session: { ...DETAILS.session, context_max: 1_000_000 } }).session?.context_max).toBe(1_000_000);
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

describe('ago and contextShare', () => {
  it('says how long ago in words', () => {
    expect(ago(-5)).toBe('just now'); // clock skew
    expect(ago(59)).toBe('just now');
    expect(ago(180)).toBe('3 min ago');
    expect(ago(2 * 3600 + 100)).toBe('2 h ago');
    expect(ago(4 * 86400)).toBe('4 d ago');
  });

  it('is a share of the context only when its size is known', () => {
    expect(contextShare(320_562, null)).toBeNull();
    expect(contextShare(320_562, undefined)).toBeNull();
    expect(contextShare(320_562, 0)).toBeNull();
    expect(contextShare(null, 1_000_000)).toBeNull();
    expect(contextShare(250_000, 1_000_000)).toBe(0.25);
    expect(contextShare(2_000_000, 1_000_000)).toBe(1);
  });
});
