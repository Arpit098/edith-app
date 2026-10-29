import { localEvent } from '../../../core/events';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { applyStatus, createLiveModel, initialLive, MAX_ITEMS, reduce, summarize, type LiveState } from '../model';

function run(events: Parameters<typeof reduce>[1][], from: LiveState = initialLive): LiveState {
  return events.reduce(reduce, from);
}

describe('reduce', () => {
  it('builds the transcript newest first', () => {
    const s = run([
      ev('message.user', { text: 'check disk', voice: true }, { origin: 'app' }),
      ev('message.assistant', { text: 'On it.' }),
      ev('file.diff', { path: '/a.ts', diff: '-a\n+b' }),
    ]);
    expect(s.items.map((x) => x.kind)).toEqual(['diff', 'assistant', 'user']);
    expect(s.items[2]).toMatchObject({ kind: 'user', origin: 'app', voice: true, text: 'check disk' });
    expect(new Set(s.items.map((x) => x.id)).size).toBe(3);
  });

  it('pairs tool results with the oldest open call of that tool', () => {
    const s = run([
      ev('tool.call', { name: 'Bash', summary: '$ ls' }),
      ev('tool.call', { name: 'Read', summary: 'a.ts' }),
      ev('tool.call', { name: 'Bash', summary: '$ df' }),
      ev('tool.result', { name: 'Bash', ok: true, summary: 'a b c' }),
      ev('tool.result', { name: 'Bash', ok: false, summary: 'df: denied' }),
      ev('tool.result', { name: 'Grep', ok: true, summary: 'orphan' }),
    ]);
    const tools = s.items.filter((x) => x.kind === 'tool').reverse();
    expect(tools.map((t) => (t.kind === 'tool' ? [t.summary, t.status, t.result] : null))).toEqual([
      ['$ ls', 'ok', 'a b c'],
      ['a.ts', 'running', null],
      ['$ df', 'error', 'df: denied'],
      ['', 'ok', 'orphan'],
    ]);
    expect(s.openCalls).toEqual({ Bash: [], Read: [2] });
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
    expect(s.items.map((x) => (x.kind === 'system' ? x.text : x.kind)).reverse()).toEqual([
      '⏳ Queued (#2)',
      '⏹ A queued message was dropped',
      '⏹ Stopped',
      '⚠️ The turn ended with an error (error_max_turns)',
    ]);
  });

  it('marks session changes and clears buttons by key', () => {
    let s = run([
      ev('tool.call', { name: 'Bash', summary: 'x' }),
      ev('message.system', { text: '🔐 Approve?', key: 'perm:ab', buttons: [[{ label: 'Allow', action: 'perm:allow:ab' }]] }),
      ev('session.changed', { session_id: 's2', title: 'youtube', source: 'resume' }),
    ]);
    expect(s.session).toEqual({ id: 's2', title: 'youtube' });
    expect(s.openCalls).toEqual({});
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
      tmux: 'running',
      conversation: true,
      session: { id: 's1', title: 'T' },
    });
    expect(summarize(s)).toEqual({ busy: true, step: 'Read a.ts', elapsed: 40, running: 1, queued: 1 });
    expect(s.session).toEqual({ id: 's1', title: 'T' });
  });
});

describe('createLiveModel', () => {
  it('reduces bus events and resyncs status on connect', async () => {
    const ctx = fakeContext();
    ctx.transport.on('GET /v1/status', { main: 'busy', queued: 0, runs: [], tmux: 'running', conversation: true, session: null });
    const m = createLiveModel(ctx.bus, ctx.api);
    ctx.bus.publish(ev('message.user', { text: 'hi' }));
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    await flush();
    expect(m.store.get().items).toHaveLength(1);
    expect(m.store.get().main).toBe('busy');
    m.dispose();
    ctx.bus.publish(ev('message.user', { text: 'ignored' }));
    expect(m.store.get().items).toHaveLength(1);
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
    expect(m.store.get().items).toHaveLength(2);
  });
});
