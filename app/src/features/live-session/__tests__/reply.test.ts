// Swipe to reply: quotes, finding the original, the swipe's thresholds, and the model sending,
// echoing, keeping and resending `replying_to`.

import { ev, fakeContext, MemoryStorage } from '../../../testing/fakes';
import { createLiveModel, fromHistory, initialLive, outboxOf, reduce, restoreOutbox, type Item, type LiveState } from '../model';
import { caught, swipeOffset, SWIPE, wantsSwipe } from '../../../ui/swipe';
import { findQuoted, QUOTE_MAX, quoteFrom, quoteOf, quoteText } from '../reply';

type User = Extract<Item, { kind: 'user' }>;
const users = (s: LiveState) => s.items.filter((x): x is User => x.kind === 'user');
const run = (events: Parameters<typeof reduce>[1][], from: LiveState = initialLive) => events.reduce(reduce, from);

const models: { dispose(): void }[] = [];
afterEach(() => models.splice(0).forEach((m) => m.dispose()));

describe('quotes', () => {
  it('are one line, cut at the server’s length with "…"', () => {
    expect(quoteText('  Disk is\n\n  40%   full ')).toBe('Disk is 40% full');
    const long = quoteText('word '.repeat(200));
    expect(long).toHaveLength(QUOTE_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('come from Arpit’s and EDITH’s messages only', () => {
    const s = run([
      ev('message.assistant', { text: 'Disk is 40% full.' }),
      ev('message.user', { text: '', attachments: ['/inbox/photo.jpg'] }, { origin: 'app' }),
      ev('tool.call', { id: 't1', name: 'Bash', summary: '$ df' }),
    ]);
    const [tool, photo, reply] = s.items;
    expect(quoteOf(reply!)).toEqual({ text: 'Disk is 40% full.', from: 'edith' });
    expect(quoteOf(photo!)).toEqual({ text: '📎 photo.jpg', from: 'arpit' }); // no words: its file names
    expect(quoteOf(tool!)).toBeNull();
  });

  it('find their original: the newest match older than the reply, also from a cut quote', () => {
    const long = 'x'.repeat(400);
    const s = run([
      ev('message.assistant', { text: 'Done.' }),
      ev('message.assistant', { text: long }),
      ev('message.assistant', { text: 'Done.' }),
      ev('message.user', { text: 'thanks', replying_to: 'Done.' }, { origin: 'telegram' }),
      ev('message.assistant', { text: 'Done.' }), // newer than the reply: never the one it quotes
    ]);
    const reply = s.items.find((x) => x.kind === 'user')!;
    expect(findQuoted(s.items, 'Done.', reply.id)).toBe(2); // the newest older "Done."
    expect(findQuoted(s.items, quoteText(long), reply.id)).toBe(3);
    expect(findQuoted(s.items, 'not here', reply.id)).toBe(-1);
    expect(quoteFrom(s.items, 'Done.')).toBe('edith');
    expect(quoteFrom(s.items, 'not here')).toBeNull();
  });
});

describe('the swipe', () => {
  it('starts only on a clearly sideways drag to the right', () => {
    expect(wantsSwipe(20, 3)).toBe(true);
    expect(wantsSwipe(20, 15)).toBe(false); // a scroll
    expect(wantsSwipe(-30, 0)).toBe(false); // to the left
    expect(wantsSwipe(SWIPE.start, 0)).toBe(false); // a tap's jitter
  });

  it('follows the finger, then resists, never past the max; catches past the catch point', () => {
    expect(swipeOffset(-10)).toBe(0);
    expect(swipeOffset(40)).toBe(40);
    expect(swipeOffset(SWIPE.catch + 20)).toBeCloseTo(SWIPE.catch + 7);
    expect(swipeOffset(1000)).toBe(SWIPE.max);
    expect(caught(SWIPE.catch - 1)).toBe(false);
    expect(caught(SWIPE.catch)).toBe(true);
  });
});

describe('replying', () => {
  it('sends the quote as replying_to, shows it on the bubble, and keeps it through the echo and a history rebuild', async () => {
    const ctx = fakeContext();
    ctx.transport.on('POST /v1/messages', { ref: 'app:r1', lane: 'main' });
    const m = createLiveModel(ctx.bus, ctx.api);
    models.push(m);
    ctx.bus.publish(ev('message.assistant', { text: 'Disk is 40% full.' }));
    const quote = quoteOf(m.store.get().items[0]!)!;

    await m.send('and now?', { replyTo: quote });
    const post = ctx.transport.calls.find((c) => c.path === '/v1/messages')!;
    expect(post.body).toEqual({ text: 'and now?', replying_to: { text: 'Disk is 40% full.', from: 'edith' } });
    expect(users(m.store.get())[0]).toMatchObject({ text: 'and now?', replyTo: quote });

    // The server's record: the same quote back as text.
    ctx.bus.publish(ev('message.user', { ref: 'app:r1', text: 'and now?', replying_to: 'Disk is 40% full.', delivery: 'main' }, { origin: 'app' }));
    expect(users(m.store.get())).toHaveLength(1);
    expect(users(m.store.get())[0]!.replyTo).toEqual(quote);

    // A history page from an older server without replying_to keeps the quote shown here.
    const page = {
      session_id: 's1',
      events: [ev('message.assistant', { text: 'Disk is 40% full.', cursor: 's1:1' }), ev('message.user', { ref: 'app:r1', text: 'and now?', cursor: 's1:2' }, { origin: 'app' })],
      start: 's1:0',
      cursor: 's1:2',
      more: false,
      reset: false,
    };
    expect(users(fromHistory(m.store.get(), page))[0]!.replyTo).toEqual(quote);
  });

  it('a message without a quote sends no replying_to', async () => {
    const ctx = fakeContext();
    ctx.transport.on('POST /v1/messages', { ref: 'app:r2', lane: 'main' });
    const m = createLiveModel(ctx.bus, ctx.api);
    models.push(m);
    await m.send('hello');
    expect(ctx.transport.calls.find((c) => c.path === '/v1/messages')!.body).toEqual({ text: 'hello' });
  });

  it('a reply from another device shows its quote, with who wrote it when the original is loaded', () => {
    const s = run([
      ev('message.user', { text: 'run the tests' }, { origin: 'telegram' }),
      ev('message.user', { text: 'again', replying_to: 'run the tests' }, { origin: 'telegram' }),
      ev('message.user', { text: 'and that', replying_to: 'something older' }, { origin: 'telegram' }),
    ]);
    const [older, again] = users(s);
    expect(again!.replyTo).toEqual({ text: 'run the tests', from: 'arpit' });
    expect(older!.replyTo).toEqual({ text: 'something older', from: null });
    expect(users(run([ev('message.user', { text: 'plain', replying_to: null }, { origin: 'app' })]))[0]!.replyTo).toBeNull();
  });

  it('keeps the quote in the outbox across a restart, and sends it when the message goes again', async () => {
    const quote = { text: 'Disk is 40% full.', from: 'edith' as const };
    const storage = new MemoryStorage();
    const ctx = fakeContext();
    ctx.transport.on('POST /v1/messages', () => Promise.reject(new Error('offline')));
    const m = createLiveModel(ctx.bus, ctx.api, storage);
    models.push(m);
    await m.send('and now?', { replyTo: quote });
    const saved = outboxOf(m.store.get());
    expect(saved[0]).toMatchObject({ text: 'and now?', replyTo: quote });

    const restored = restoreOutbox(initialLive, saved, Date.now() / 1000);
    const item = users(restored)[0]!;
    expect(item.replyTo).toEqual(quote);

    // Retry after a failure sends the quote again.
    ctx.transport.on('POST /v1/messages', { ref: 'app:r3', lane: 'main' });
    const failed = users(m.store.get())[0]!;
    if (failed.local?.status === 'failed') await m.retry(failed.local.key);
    const posts = ctx.transport.calls.filter((c) => c.path === '/v1/messages');
    expect(posts.every((c) => (c.body as { replying_to?: unknown }).replying_to !== undefined)).toBe(true);
  });
});
