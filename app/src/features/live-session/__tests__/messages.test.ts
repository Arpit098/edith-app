// A sent message never vanishes: states, side lanes, ticks, reactions, the working row and the outbox.

import { ApiError } from '../../../core/api';
import { localEvent } from '../../../core/events';
import { ev, fakeContext, flush, MemoryStorage } from '../../../testing/fakes';
import {
  createLiveModel,
  initialLive,
  OUTBOX_KEY,
  outboxOf,
  reduce,
  restoreOutbox,
  sendStatus,
  stripAppHeader,
  tickOf,
  workingLabel,
  type Item,
  type LiveState,
} from '../model';

type User = Extract<Item, { kind: 'user' }>;
const users = (s: LiveState) => s.items.filter((x): x is User => x.kind === 'user');
const mine = (s: LiveState) => users(s).find((x) => x.local)!;
const STATUS = { main: 'busy', queued: 0, runs: [{ ref: 'r-main', lane: 'main', seconds: 30, step: '$ npm test' }], tmux: 'running', conversation: true, session: null };
const EMPTY_PAGE = { session_id: 's1', events: [], start: 's1:0', cursor: 's1:9', more: false, reset: false };

// Every model is disposed after its test, even a failing one: a live retry timer would keep jest running.
const models: { dispose(): void }[] = [];
afterEach(() => models.splice(0).forEach((m) => m.dispose()));

function setup(storage = new MemoryStorage()) {
  const ctx = fakeContext();
  ctx.transport.on('GET /v1/status', STATUS).on('GET /v1/sessions/current/history?limit=100', EMPTY_PAGE);
  const m = createLiveModel(ctx.bus, ctx.api, storage);
  models.push(m);
  return { ctx, m, storage };
}

describe('the lost side-lane message (Arpit, 18:17:53 UTC)', () => {
  it('shows the message, its side lane and the side-lane answer, and keeps them through a history refetch', async () => {
    const { ctx, m } = setup();
    // The main lane is busy with something else.
    ctx.bus.publish(ev('turn.started', { ref: 'r-main', lane: 'main' }));
    ctx.bus.publish(ev('turn.progress', { ref: 'r-main', lane: 'main', step: '$ npm test', steps: 3 }));

    // Arpit sends; the server answers in a parallel side lane.
    let answer: (v: unknown) => void = () => {};
    ctx.transport.on('POST /v1/messages', () => new Promise((r) => (answer = r)));
    const sending = m.send("What's going on?");
    expect(mine(m.store.get())).toMatchObject({ text: "What's going on?", local: { status: 'sending' } });
    expect(tickOf(mine(m.store.get()), m.store.get().turns)).toBe('clock');

    // The side lane can start before the POST answers.
    ctx.bus.publish(ev('turn.started', { ref: 'app:side1', lane: 'side' }, { origin: 'app' }));
    answer({ ref: 'app:side1', lane: 'side' });
    await sending;
    let s = m.store.get();
    expect(mine(s)).toMatchObject({ ref: 'app:side1', delivery: 'side_lane', local: { status: 'sent' } });
    expect(sendStatus(mine(s), s.turns)).toBe('side');
    expect(tickOf(mine(s), s.turns)).toBe('delivered');

    ctx.bus.publish(ev('turn.progress', { ref: 'app:side1', lane: 'side', step: 'Bash: uptime', steps: 1 }));
    ctx.bus.publish(ev('turn.done', { ref: 'app:side1', lane: 'side', text: 'Main lane is running the tests; all fine.' }, { origin: 'app' }));
    s = m.store.get();
    expect(sendStatus(mine(s), s.turns)).toBe('answered');
    expect(s.items.find((x) => x.kind === 'assistant')).toMatchObject({ lane: 'side', ref: 'app:side1', text: 'Main lane is running the tests; all fine.' });
    expect(s.runs['r-main']).toBeDefined(); // the main lane is still busy, as before

    // A reconnect refetches history, which doesn't hold side-lane turns: nothing vanishes.
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    await flush();
    s = m.store.get();
    expect(users(s).map((x) => x.text)).toEqual(["What's going on?"]);
    expect(s.items.filter((x) => x.kind === 'assistant')).toHaveLength(1);
    m.dispose();
  });

  it('shows a side-lane answer once even when the server also sends it as message.assistant', () => {
    const s = [
      ev('turn.done', { ref: 'r1', lane: 'side', text: 'answer' }),
      ev('message.assistant', { text: 'answer', lane: 'side', ref: 'r1' }),
    ].reduce(reduce, initialLive);
    expect(s.items.filter((x) => x.kind === 'assistant')).toHaveLength(1);
  });
});

describe('message states', () => {
  it('matches the server record by ref (coming message.user {ref, delivery}) instead of showing it twice', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/messages', { ref: 'app:9', lane: 'queued' });
    await m.send('deploy it');
    expect(sendStatus(mine(m.store.get()), m.store.get().turns)).toBe('queued');
    ctx.bus.publish(ev('message.user', { text: '[App message from Arpit, 2026-11-02 10:43 IST]\ndeploy it', ref: 'app:9', delivery: 'queued' }, { origin: 'app' }));
    expect(users(m.store.get())).toHaveLength(1);
    expect(mine(m.store.get())).toMatchObject({ echoed: true, delivery: 'queued' });
    m.dispose();
  });

  it('matches today\'s transcript echo (no ref, with the App header) by text, oldest first', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/messages', { ref: 'app:1', lane: 'main' });
    await m.send('hi');
    ctx.transport.on('POST /v1/messages', { ref: 'app:2', lane: 'main' });
    await m.send('hi');
    ctx.bus.publish(ev('message.user', { text: '[App message from Arpit, 2026-11-02 10:43 IST] [voice]\nhi' }, { origin: 'app' }));
    const list = users(m.store.get());
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.ref === 'app:1')?.echoed).toBe(true); // the first one sent
    expect(list.find((x) => x.ref === 'app:2')?.echoed).toBe(false);
    m.dispose();
  });

  it('marks a failed send with Retry, and Retry sends it again', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/messages', () => {
      throw new ApiError(400, 'text is required');
    });
    await m.send('oops');
    expect(mine(m.store.get())).toMatchObject({ local: { status: 'failed', error: 'text is required' } });
    expect(tickOf(mine(m.store.get()), m.store.get().turns)).toBe('failed');
    ctx.transport.on('POST /v1/messages', { ref: 'app:3', lane: 'main' });
    await m.retry(mine(m.store.get()).local!.key);
    expect(mine(m.store.get())).toMatchObject({ ref: 'app:3', local: { status: 'sent' } });
    m.dispose();
  });

  it('a failed turn shows as failed on its message', () => {
    let s = [ev('turn.started', { ref: 'r', lane: 'main' })].reduce(reduce, initialLive);
    s = { ...s, items: [{ kind: 'user', id: 99, ts: 1, text: 'x', origin: 'app', voice: false, ref: 'r', delivery: 'main', local: { key: 'k', status: 'sent', error: null }, echoed: false, reaction: null }] };
    s = reduce(s, ev('turn.failed', { ref: 'r', reason: 'crashed' }));
    expect(tickOf(mine(s), s.turns)).toBe('failed');
    expect(sendStatus(mine(s), s.turns)).toBe('failed');
  });

  it('strips the App header from echoes', () => {
    expect(stripAppHeader('[App message from Arpit, 2026-11-02 10:43 IST] [voice]\nhello')).toBe('hello');
    expect(stripAppHeader('[App message from Arpit, 2026-11-02 10:43 IST]\nhello\nworld')).toBe('hello\nworld');
    expect(stripAppHeader('hello [App message from x]')).toBe('hello [App message from x]');
  });
});

describe('ticks, reactions and the working row', () => {
  it('ticks: clock, then sent, then delivered on message.delivered', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/messages', { ref: 'app:5', lane: 'queued' });
    await m.send('later');
    expect(tickOf(mine(m.store.get()), m.store.get().turns)).toBe('sent');
    ctx.bus.publish(ev('message.delivered', { ref: 'app:5' }));
    expect(tickOf(mine(m.store.get()), m.store.get().turns)).toBe('delivered');
    m.dispose();
  });

  it('reactions: the latest wins', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/messages', { ref: 'app:6', lane: 'main' });
    await m.send('check disk');
    for (const emoji of ['👀', '👨‍💻', '👍']) ctx.bus.publish(ev('message.reaction', { ref: 'app:6', emoji }));
    expect(mine(m.store.get()).reaction).toBe('👍');
    m.dispose();
  });

  it('working row: turn.state first, turn events as a fallback, approvals on top, hidden when idle', () => {
    let s = reduce(initialLive, ev('turn.started', { ref: 'r', lane: 'main' }));
    expect(workingLabel(s)).toBe('Thinking');
    s = reduce(s, ev('turn.progress', { ref: 'r', lane: 'main', step: '$ df -h' }));
    expect(workingLabel(s)).toBe('Running $ df -h');
    s = reduce(s, ev('turn.state', { ref: 'r', state: 'running', tool: 'Bash' }));
    expect(workingLabel(s)).toBe('Running Bash');
    s = reduce(s, ev('permission.request', { id: 'p1', tool: 'Bash', detail: 'rm' }));
    expect(workingLabel(s)).toBe('Waiting for your approval');
    s = reduce(s, ev('permission.resolved', { id: 'p1' }));
    s = reduce(s, ev('turn.state', { ref: 'r', state: 'speaking' }));
    expect(workingLabel(s)).toBe('Speaking');
    s = reduce(s, ev('turn.done', { ref: 'r' }));
    expect(workingLabel(s)).toBeNull();
    // A turn whose end was missed is cleared once the lanes are idle.
    s = reduce(reduce(s, ev('turn.started', { ref: 'lost' })), ev('lane.status', { main: 'idle', side: 0, queued: 0 }));
    expect(workingLabel(s)).toBeNull();
  });
});

describe('the outbox', () => {
  it('waits offline, sends on reconnect in order, and persists until the server has it', async () => {
    const { ctx, m, storage } = setup();
    ctx.transport.on('POST /v1/messages', () => {
      throw new ApiError(0, 'Network request failed');
    });
    await m.send('first');
    await m.send('second');
    expect(users(m.store.get()).map((x) => x.local?.status)).toEqual(['waiting', 'waiting']);
    await flush(); // the outbox is written asynchronously
    expect(JSON.parse(storage.data.get(OUTBOX_KEY) ?? '[]').map((e: { text: string }) => e.text)).toEqual(['first', 'second']);

    const sent: string[] = [];
    let n = 0;
    ctx.transport.on('POST /v1/messages', (body: unknown) => {
      sent.push((body as { text: string }).text);
      return { ref: `app:${++n}`, lane: 'main' };
    });
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    await flush();
    await flush();
    expect(sent).toEqual(['first', 'second']);
    expect(users(m.store.get()).every((x) => x.local?.status === 'sent')).toBe(true);

    ctx.bus.publish(ev('message.user', { text: 'first' }, { origin: 'app' }));
    ctx.bus.publish(ev('message.user', { text: 'second' }, { origin: 'app' }));
    await flush();
    expect(JSON.parse(storage.data.get(OUTBOX_KEY) ?? 'null')).toEqual([]); // echoed: nothing left to keep
    m.dispose();
  });

  it('a timeout is not resent by itself (it may have arrived)', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/messages', () => {
      throw new ApiError(0, 'timed out');
    });
    await m.send('maybe');
    expect(mine(m.store.get()).local?.status).toBe('failed');
    m.dispose();
  });

  it('comes back after a restart: waiting ones go again, in-flight ones wait for a tap', async () => {
    const storage = new MemoryStorage();
    const now = Date.now() / 1000;
    storage.data.set(
      OUTBOX_KEY,
      JSON.stringify([
        { key: 'a', text: 'was waiting', voice: false, ts: now - 60, status: 'waiting', error: 'offline', ref: null, delivery: null },
        { key: 'b', text: 'was in flight', voice: true, ts: now - 30, status: 'sending', error: null, ref: null, delivery: null },
        { key: 'c', text: 'side lane, not echoed', voice: false, ts: now - 10, status: 'sent', error: null, ref: 'app:7', delivery: 'side_lane' },
      ]),
    );
    const { ctx, m } = setup(storage);
    const sent: string[] = [];
    ctx.transport.on('POST /v1/messages', (body: unknown) => {
      sent.push((body as { text: string }).text);
      return { ref: 'app:8', lane: 'main' };
    });
    await flush();
    await flush();
    await flush();
    const list = users(m.store.get());
    expect(list.map((x) => x.text)).toEqual(['side lane, not echoed', 'was in flight', 'was waiting']); // newest first
    expect(sent).toEqual(['was waiting']);
    expect(list.find((x) => x.text === 'was in flight')?.local?.status).toBe('failed');
    expect(list.find((x) => x.text === 'side lane, not echoed')).toMatchObject({ ref: 'app:7', delivery: 'side_lane' });
    m.dispose();
  });

  it('old waiting messages wait for a tap', () => {
    const s = restoreOutbox(initialLive, [{ key: 'x', text: 'yesterday', voice: false, ts: 0, status: 'waiting', error: null, ref: null, delivery: null }], 100_000);
    expect(mine(s).local?.status).toBe('failed');
    expect(outboxOf(s)).toHaveLength(1);
  });
});
