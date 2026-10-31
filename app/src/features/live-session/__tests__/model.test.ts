import type { HistoryPage } from '../../../core/api';
import { localEvent, type EdithEvent } from '../../../core/events';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { applyStatus, createLiveModel, needsArgs, fromHistory, initialLive, MAX_ITEMS, reduce, summarize, withOlder, type LiveState } from '../model';

function run(events: EdithEvent[], from: LiveState = initialLive): LiveState {
  return events.reduce(reduce, from);
}

const texts = (s: LiveState) => s.items.map((x) => ('text' in x ? x.text : 'summary' in x ? x.summary : x.kind)).reverse();

/** A user message at transcript offset n of session s1. */
const say = (n: number, text = `m${n}`) => ev('message.user', { text, cursor: `s1:${n}` });

function page(events: EdithEvent[], extra: Partial<HistoryPage> = {}): Record<string, unknown> {
  const last = events.at(-1)?.data.cursor ?? 's1:0';
  return { session_id: 's1', events, start: events[0]?.data.cursor ?? 's1:0', cursor: last, more: false, reset: false, ...extra };
}

const STATUS = { main: 'idle', queued: 0, runs: [], tmux: 'running', conversation: true, session: null };

describe('reduce', () => {
  it('builds the transcript newest first and remembers the cursor', () => {
    const s = run([
      ev('message.user', { text: 'check disk', voice: true, cursor: 's1:10' }, { origin: 'app' }),
      ev('message.assistant', { text: 'On it.', cursor: 's1:20' }),
      ev('file.diff', { id: 't1', path: '/a.ts', diff: '-a\n+b', cursor: 's1:30' }),
      ev('turn.started', { ref: 'r' }), // not a transcript event: cursor unchanged
    ]);
    expect(s.items.map((x) => x.kind)).toEqual(['diff', 'assistant', 'user']);
    expect(s.items[2]).toMatchObject({ kind: 'user', origin: 'app', voice: true, text: 'check disk' });
    expect(s.cursor).toBe('s1:30');
  });

  it('pairs tool results with their call by id', () => {
    const s = run([
      ev('tool.call', { id: 'a', name: 'Bash', summary: '$ ls' }),
      ev('tool.call', { id: 'b', name: 'Bash', summary: '$ df' }),
      ev('tool.result', { id: 'b', name: 'Bash', ok: false, summary: 'df: denied' }), // out of order
      ev('tool.result', { id: 'a', name: '', ok: true, summary: 'a b c' }), // name can be "" in history
      ev('tool.result', { id: 'zz', name: 'Grep', ok: true, summary: 'orphan' }),
    ]);
    const tools = s.items.filter((x) => x.kind === 'tool').reverse();
    expect(tools.map((t) => (t.kind === 'tool' ? [t.summary, t.status, t.result] : null))).toEqual([
      ['$ ls', 'ok', 'a b c'],
      ['$ df', 'error', 'df: denied'],
      ['', 'ok', 'orphan'],
    ]);
    expect(s.calls).toEqual({});
  });

  it('keeps the same state for events it does not show', () => {
    const s = run([ev('message.user', { text: 'x' })]);
    expect(reduce(s, ev('reminder.due', { id: '1' }))).toBe(s);
    expect(reduce(s, ev('message.buttons_cleared', { key: 'nope' }))).toBe(s);
  });

  it('tracks turns and lanes', () => {
    let s = run([
      ev('turn.started', { ref: 'r1', lane: 'main' }),
      ev('turn.progress', { ref: 'r1', lane: 'main', steps: 3, step: '$ npm test', elapsed: 12 }),
      ev('turn.started', { ref: 'r2', lane: 'side' }),
    ]);
    expect(summarize(s)).toEqual({ busy: true, step: '$ npm test', elapsed: 12, running: 2, queued: 0 });
    s = run([ev('turn.done', { ref: 'r1', text: 'ok' }), ev('turn.failed', { ref: 'r2', reason: 'crashed', detail: 'exit 1' }), ev('lane.status', { main: 'idle', side: 0, queued: 0 })], s);
    expect(summarize(s).busy).toBe(false);
    expect(s.items[0]).toMatchObject({ kind: 'system', tone: 'error', text: '❌ Claude crashed: exit 1' });
  });

  it('shows stops, queueing and errors', () => {
    const s = run([
      ev('turn.queued', { ref: 'q', position: 2 }),
      ev('turn.stopped', { ref: 'q', lane: 'queued' }),
      ev('turn.stopped', { ref: 'r', lane: 'main' }),
      ev('turn.done', { ref: 'r3', is_error: true, subtype: 'error_max_turns' }),
    ]);
    expect(texts(s)).toEqual(['⏳ Queued (#2)', '⏹ A queued message was dropped', '⏹ Stopped', '⚠️ The turn ended with an error (error_max_turns)']);
  });

  it('marks session changes and clears buttons by key', () => {
    let s = run([
      ev('message.system', { text: '🔐 Approve?', key: 'perm:ab', buttons: [[{ label: 'Allow', action: 'perm:allow:ab' }]] }),
      ev('session.changed', { session_id: 's2', title: 'youtube', source: 'resume' }),
    ]);
    expect(s.session).toEqual({ id: 's2', title: 'youtube' });
    expect(s.items[0]).toMatchObject({ kind: 'divider', text: 'youtube' });
    s = reduce(s, ev('message.buttons_cleared', { key: 'perm:ab' }));
    expect(s.items[1]).toMatchObject({ kind: 'system', buttons: [] });
  });

  it('is bounded', () => {
    let s = initialLive;
    for (let i = 0; i < MAX_ITEMS + 50; i++) s = reduce(s, ev('message.assistant', { text: String(i) }));
    expect(s.items).toHaveLength(MAX_ITEMS);
    expect(s.items[0]).toMatchObject({ text: String(MAX_ITEMS + 49) });
  });

  it('seeds from /v1/status', () => {
    const s = applyStatus(initialLive, {
      main: 'busy',
      queued: 1,
      runs: [{ ref: 'r', lane: 'main', seconds: 40, step: 'Read a.ts' }],
      background: [{ id: 'tu1', kind: 'shell', label: 'Wait for PR 41 CI', started: 100 }],
      tmux: 'running',
      conversation: true,
      session: { id: 's1', title: 'T' },
    });
    expect(summarize(s)).toEqual({ busy: true, step: 'Read a.ts', elapsed: 40, running: 1, queued: 1 });
    expect(s.session).toEqual({ id: 's1', title: 'T' });
    expect(s.background).toEqual([{ id: 'tu1', kind: 'shell', label: 'Wait for PR 41 CI', started: 100 }]);
  });

  it('keeps the background work from background.changed, whole list each time', () => {
    const bg = (jobs: unknown[]) => ev('background.changed', { jobs });
    let s = reduce(initialLive, bg([{ id: 'tu1', kind: 'shell', label: 'Wait for PR 41 CI', started: 100 }, { id: 'tu2', kind: 'agent', label: 'Review PR 41', started: null }, 'junk']));
    expect(s.background).toEqual([
      { id: 'tu1', kind: 'shell', label: 'Wait for PR 41 CI', started: 100 },
      { id: 'tu2', kind: 'agent', label: 'Review PR 41', started: null },
    ]);
    expect(summarize(s).busy).toBe(false); // not a turn: no Stop, no timer
    s = reduce(s, bg([]));
    expect(s.background).toEqual([]);
  });

  it("the main lane is idle once its turn ends, with no lane.status (the server sends none)", () => {
    // Arpit's report: after the reply, the chip kept thinking, with its timer and Stop, until a reconnect.
    const start = run([ev('turn.started', { ref: 'r1', lane: 'main' })]);
    expect(summarize(start).busy).toBe(true);
    for (const end of [
      ev('turn.done', { ref: 'r1', lane: 'main', text: 'ok' }),
      ev('turn.stopped', { ref: 'r1', lane: 'main' }),
      ev('turn.failed', { ref: 'r1', lane: 'main', reason: 'crashed', detail: '' }),
    ]) {
      expect([reduce(start, end).main, summarize(reduce(start, end)).busy]).toEqual(['idle', false]);
    }
    // Ends that aren't the running main turn leave it busy: a side lane, a dropped queued message, a refused one.
    for (const other of [
      ev('turn.done', { ref: 's1', lane: 'side', text: 'ok' }),
      ev('turn.stopped', { ref: 'q1', lane: 'queued' }),
      ev('turn.failed', { ref: 'q2', lane: 'main', reason: 'queue_full', detail: '' }),
    ]) {
      expect(reduce(start, other).main).toBe('busy');
    }
  });
});

describe('history pages', () => {
  const hp = (events: EdithEvent[], extra: Partial<HistoryPage> = {}) => page(events, extra) as unknown as HistoryPage;

  it('rebuilds the transcript from the newest page, keeping turn state', () => {
    const before = run([say(1, 'old'), ev('turn.started', { ref: 'r', lane: 'main' })]);
    const s = fromHistory(before, hp([say(5), say(6)], { start: 's1:4', more: true }));
    expect(texts(s)).toEqual(['m5', 'm6']);
    expect(s.cursor).toBe('s1:6');
    expect(s.older).toBe('s1:4');
    expect(summarize(s).busy).toBe(true);
  });

  it('adds older pages below, within MAX_ITEMS', () => {
    const s = fromHistory(initialLive, hp([say(5)], { start: 's1:5', more: true }));
    const t = withOlder(s, hp([say(3), say(4)], { start: 's1:3', more: true }));
    expect(texts(t)).toEqual(['m3', 'm4', 'm5']);
    expect(t.older).toBe('s1:3');
    expect(new Set(t.items.map((x) => x.id)).size).toBe(3);
    expect(t.cursor).toBe('s1:5'); // older pages never move the catch-up cursor
    expect(withOlder(t, hp([say(2)]))).toMatchObject({ older: null });
  });
});

describe('createLiveModel', () => {
  it('fills from history on open, without repeating events that came in meanwhile', async () => {
    const ctx = fakeContext();
    let answer: (v: unknown) => void = () => {};
    ctx.transport.on('GET /v1/status', STATUS).on('GET /v1/sessions/current/history?limit=100', () => new Promise((r) => (answer = r)));
    const m = createLiveModel(ctx.bus, ctx.api);
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    ctx.bus.publish(say(2)); // arrives during the request, and is in the page too
    ctx.bus.publish(say(3)); // arrives during the request, newer than the page
    ctx.bus.publish(ev('turn.started', { ref: 'r', lane: 'main' })); // not a transcript event: applied at once
    expect(summarize(m.store.get()).busy).toBe(true);
    answer(page([say(1), say(2)]));
    await flush();
    expect(texts(m.store.get())).toEqual(['m1', 'm2', 'm3']);
    expect(m.store.get().cursor).toBe('s1:3');
    m.dispose();
  });

  it('catches up after a reconnect with after= until there is no more', async () => {
    const ctx = fakeContext();
    ctx.transport
      .on('GET /v1/status', STATUS)
      .on('GET /v1/sessions/current/history?limit=100', page([say(1)]))
      .on('GET /v1/sessions/current/history?after=s1%3A1&limit=100', page([say(2)], { more: true }))
      .on('GET /v1/sessions/current/history?after=s1%3A2&limit=100', page([say(3)]));
    const m = createLiveModel(ctx.bus, ctx.api);
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    await flush();
    expect(texts(m.store.get())).toEqual(['m1', 'm2', 'm3']);
    expect(ctx.transport.calls.filter((c) => c.path.includes('/history')).map((c) => c.path.split('?')[1])).toEqual([
      'limit=100',
      'after=s1%3A1&limit=100',
      'after=s1%3A2&limit=100',
    ]);
    m.dispose();
  });

  it('starts over from the newest page when the cursor belongs to another conversation', async () => {
    const ctx = fakeContext();
    ctx.transport
      .on('GET /v1/status', STATUS)
      .on('GET /v1/sessions/current/history?limit=100', page([say(1)]))
      .on('GET /v1/sessions/current/history?after=s1%3A1&limit=100', {
        ...page([ev('message.user', { text: 'other', cursor: 's2:9' })]),
        reset: true,
      });
    const m = createLiveModel(ctx.bus, ctx.api);
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(texts(m.store.get())).toEqual(['other']);
    expect(m.store.get().cursor).toBe('s2:9');
    m.dispose();
  });

  it('shows the new conversation after a session change, and loads older pages', async () => {
    const ctx = fakeContext();
    let current = page([say(1)]);
    ctx.transport
      .on('GET /v1/status', STATUS)
      .on('GET /v1/sessions/current/history?limit=100', () => current)
      .on('GET /v1/sessions/current/history?before=s2%3A5&limit=100', page([ev('message.user', { text: 'older', cursor: 's2:4' })]));
    const m = createLiveModel(ctx.bus, ctx.api);
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    current = page([ev('message.user', { text: 'in s2', cursor: 's2:5' })], { start: 's2:5', more: true });
    ctx.bus.publish(ev('session.changed', { session_id: 's2', title: 'other', source: 'resume' }));
    await flush();
    expect(texts(m.store.get())).toEqual(['in s2']);
    await m.loadOlder();
    expect(texts(m.store.get())).toEqual(['older', 'in s2']);
    expect(m.store.get()).toMatchObject({ older: null, loadingOlder: false });
    m.dispose();
  });

  it('keeps the stream events when history fails', async () => {
    const ctx = fakeContext();
    ctx.transport.on('GET /v1/status', STATUS).on('GET /v1/sessions/current/history?limit=100', () => Promise.reject(new Error('timed out')));
    const m = createLiveModel(ctx.bus, ctx.api);
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    ctx.bus.publish(say(7));
    await flush();
    expect(texts(m.store.get())).toEqual(['m7']);
    m.dispose();
  });

  it('sends, stops and presses buttons', async () => {
    const ctx = fakeContext();
    ctx.transport
      .on('POST /v1/messages', { ref: 'app:1', lane: 'main' })
      .on('POST /v1/stop', { running: 1, dropped: ['q'] })
      .on('POST /v1/actions', { ref: 'app:9', toast: 'Snoozed', note: '💤 15m', replies: [] });
    const m = createLiveModel(ctx.bus, ctx.api);
    await m.send('run the tests');
    expect(ctx.transport.calls[0]).toMatchObject({ path: '/v1/messages', body: { text: 'run the tests' } });
    expect(await m.stop()).toBe('Stopped 2 tasks');

    ctx.bus.publish(ev('message.system', { text: '⏰ Renew', buttons: [[{ label: '+15m', action: 'rem:snooze:15:ab' }]] }));
    const id = m.store.get().items[0]!.id;
    expect(await m.press(id, 'rem:snooze:15:ab')).toBe('Snoozed');
    expect(m.store.get().items[0]).toMatchObject({ buttons: [], note: '💤 15m' });

    ctx.bus.publish(ev('command.reply', { ref: 'app:9', text: 'later reply' }));
    ctx.bus.publish(ev('command.reply', { ref: 'someone-else', text: 'not mine' }));
    expect(m.store.get().items[0]).toMatchObject({ kind: 'system', text: 'later reply' });
    expect(m.store.get().items).toHaveLength(3); // the sent message, the system message and the later reply
    m.dispose();
  });

  it("lists the composer menu's commands once, without the ones the app has controls for, and asks again after a failure", async () => {
    const ctx = fakeContext();
    let fail = true;
    ctx.transport.on('GET /v1/commands', () => {
      if (fail) throw new Error('offline');
      return {
        commands: [
          { name: 'compact', description: 'Compact the context', usage: '', help: '' },
          { name: 'stop', description: 'Stop', usage: '', help: '' },
          { name: 'restart', description: 'Restart EDITH', usage: '', help: '' }, // too drastic for one tap
          { name: 'remind', description: 'Set a reminder', usage: '<when> <what>', help: '' },
        ],
      };
    });
    const m = createLiveModel(ctx.bus, ctx.api);
    await expect(m.commands()).rejects.toThrow('offline');
    fail = false;
    expect((await m.commands()).map((c) => c.name)).toEqual(['compact', 'remind']);
    await m.commands();
    expect(ctx.transport.calls.filter((c) => c.path === '/v1/commands')).toHaveLength(2); // the failure and one success
    m.dispose();
  });
});

describe('needsArgs', () => {
  it('asks for arguments only when the usage names required ones', () => {
    expect(needsArgs({ usage: '' })).toBe(false);
    expect(needsArgs({ usage: '[instructions]' })).toBe(false); // /compact: optional, runs at once
    expect(needsArgs({ usage: '  [n]' })).toBe(false);
    expect(needsArgs({ usage: '<when> <what>' })).toBe(true);
    expect(needsArgs({ usage: 'text' })).toBe(true);
  });
});
