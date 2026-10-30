// Attachments: upload at once with progress, limits, the 404 "server update" message, retry, remove
// (cancels the upload, deletes the file), take() that never drops one, expiry, and a message sent
// with attachment ids that keeps its thumbnails.

import { ApiError } from '../../../core/api';
import type { MediaPicker, PickedFile } from '../../../core/ports';
import { toPrune } from '../../../adapters/media/expo/prune';
import { ev, fakeContext, flush, MemoryStorage } from '../../../testing/fakes';
import { createAttachmentsModel, ID_LIFETIME_S, MAX_ATTACHMENTS, MAX_AUDIO_BYTES, MAX_IMAGE_BYTES, uploadError, type SentAttachment } from '../attachments';
import { ATTACHMENT_EXPIRED, createLiveModel, fromHistory, initialLive, OUTBOX_KEY, outboxOf, reduce, restoreOutbox, type Item, type LiveState, type OutboxEntry } from '../model';

type User = Extract<Item, { kind: 'user' }>;
const users = (s: LiveState) => s.items.filter((x): x is User => x.kind === 'user');

const photo = (over: Partial<PickedFile> = {}): PickedFile => ({ kind: 'image', uri: 'file:///cache/attachments/p.jpg', name: 'p.jpg', mime: 'image/jpeg', size: 1000, ...over });
const song = (over: Partial<PickedFile> = {}): PickedFile => ({ kind: 'audio', uri: 'file:///cache/attachments/a.m4a', name: 'a.m4a', mime: 'audio/mp4', size: 2000, ...over });

type FakePicker = MediaPicker & { sources: string[]; discarded: string[]; sizes: Map<string, number> };

function picker(next: () => PickedFile | null | Promise<PickedFile | null>): FakePicker {
  const sources: string[] = [];
  const discarded: string[] = [];
  const sizes = new Map<string, number>();
  return {
    sources,
    discarded,
    sizes,
    pickImage: async (source) => (sources.push(source), next()),
    pickAudio: async () => (sources.push('audio'), next()),
    stat: (uri) => sizes.get(uri) ?? null,
    discard: (uri) => void discarded.push(uri),
    prune: () => {},
  };
}

function setup(next: () => PickedFile | null | Promise<PickedFile | null> = () => photo()) {
  const ctx = fakeContext();
  let n = 0;
  ctx.transport.on('UPLOAD /v1/attachments', (f: { name: string; mime: string }) => ({ id: `att_${++n}`, name: f.name, type: f.mime, size: 1000, sha256: 'x' }));
  const media = picker(next);
  let t = 1_800_000_000_000;
  const a = createAttachmentsModel({ api: ctx.api, media, now: () => (t += 1000) });
  return { ctx, a, media };
}

/** An upload that answers only when told to. */
function held(ctx: ReturnType<typeof fakeContext>) {
  let finish: (v: unknown) => void = () => {};
  ctx.transport.on('UPLOAD /v1/attachments', () => new Promise((r) => (finish = r)));
  return (id = 'att_9') => finish({ id, name: 'p.jpg', type: 'image/jpeg', size: 1000, sha256: 'x' });
}

describe('attachments in the composer', () => {
  it('uploads a picked photo at once and hands it over with its id and upload time', async () => {
    const { ctx, a, media } = setup();
    await a.add('camera');
    expect(media.sources).toEqual(['camera']);
    expect(ctx.transport.uploads).toEqual([{ path: '/v1/attachments', file: expect.objectContaining({ uri: photo().uri, mime: 'image/jpeg', name: 'p.jpg' }), field: 'raw' }]);
    expect(a.store.get().drafts[0]).toMatchObject({ status: 'ready', id: 'att_1', error: null });
    const taken = a.take();
    expect(taken).toEqual([{ id: 'att_1', name: 'p.jpg', kind: 'image', uri: photo().uri, uploaded: expect.any(Number) }]);
    expect(a.store.get().drafts).toEqual([]);
    expect(media.discarded).toEqual([]); // the image stays on disk as the bubble's thumbnail
  });

  it('shows progress while uploading; take() refuses and keeps everything until it is done', async () => {
    const { ctx, a } = setup();
    const finish = held(ctx);
    const adding = a.add('library');
    await flush();
    expect(a.store.get().drafts[0]).toMatchObject({ status: 'uploading', sent: 50, total: 100 });
    expect(a.busy()).toBe(true);
    expect(a.take()).toBeNull(); // never sent without it…
    expect(a.store.get().drafts).toHaveLength(1); // …and never dropped
    finish();
    await adding;
    expect(a.take()?.map((x) => x.id)).toEqual(['att_9']);
  });

  it('take() refuses while one failed, even with others ready', async () => {
    const { ctx, a } = setup();
    await a.add('library');
    ctx.transport.on('UPLOAD /v1/attachments', () => {
      throw new ApiError(500, 'boom');
    });
    await a.add('library');
    expect(a.store.get().drafts.map((d) => d.status)).toEqual(['ready', 'failed']);
    expect(a.take()).toBeNull();
    expect(a.store.get().drafts).toHaveLength(2);
  });

  it('says plainly when the server has no /v1/attachments yet (404), and retries', async () => {
    const { ctx, a } = setup(() => song());
    ctx.transport.on('UPLOAD /v1/attachments', () => {
      throw new ApiError(404, 'not found');
    });
    await a.add('audio');
    expect(a.store.get().drafts[0]).toMatchObject({ kind: 'audio', status: 'failed', error: 'Attachments need a server update on edith.' });

    ctx.transport.on('UPLOAD /v1/attachments', () => ({ id: 'att_7', name: 'a.m4a', type: 'audio/mp4', size: 2000, sha256: 'x' }));
    await a.retry(a.store.get().drafts[0]!.key);
    expect(a.store.get().drafts[0]).toMatchObject({ status: 'ready', id: 'att_7', error: null });
  });

  it('a sent audio file is deleted from the phone (only images stay, as thumbnails)', async () => {
    const { a, media } = setup(() => song());
    await a.add('audio');
    expect(a.take()).toEqual([expect.objectContaining({ id: 'att_1', kind: 'audio', uri: null })]);
    expect(media.discarded).toEqual([song().uri]);
  });

  it('maps the contract errors to plain messages', () => {
    expect(uploadError(new ApiError(415, 'x'))).toMatch(/doesn't take this kind of file/);
    expect(uploadError(new ApiError(413, 'x'))).toMatch(/Too big/);
    expect(uploadError(new ApiError(0, 'timed out'))).toMatch(/took too long/);
    expect(uploadError(new ApiError(0, 'network'))).toMatch(/Tailscale/);
    expect(uploadError(new ApiError(400, 'unknown attachment att_1'))).toBe('Upload failed: unknown attachment att_1');
  });

  it("uses the server's byte caps exactly (binary MB, attachments.py)", () => {
    expect(MAX_IMAGE_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_AUDIO_BYTES).toBe(25 * 1024 * 1024);
    expect(ID_LIFETIME_S).toBe(7 * 86400);
  });

  it.each([
    ['an image one byte over', () => photo({ size: MAX_IMAGE_BYTES + 1 })],
    ['audio one byte over', () => song({ size: MAX_AUDIO_BYTES + 1 })],
  ])('refuses %s before uploading, and deletes the copy', async (_name, file) => {
    const { ctx, a, media } = setup(file);
    await a.add('library');
    expect(ctx.transport.uploads).toHaveLength(0);
    expect(a.store.get()).toMatchObject({ drafts: [], picking: false, error: expect.stringMatching(/Too big/) });
    expect(media.discarded).toHaveLength(1);
  });

  it('accepts a file of exactly the cap', async () => {
    const { a } = setup(() => photo({ size: MAX_IMAGE_BYTES }));
    await a.add('library');
    expect(a.store.get().drafts[0]?.status).toBe('ready');
  });

  it('an unknown size (0) is read from the file, so the cap and the timeout still hold', async () => {
    const big = photo({ size: 0, uri: 'file:///cache/attachments/big.jpg' });
    const { ctx, a, media } = setup(() => big);
    media.sizes.set(big.uri, MAX_IMAGE_BYTES + 1);
    await a.add('library');
    expect(ctx.transport.uploads).toHaveLength(0);
    expect(a.store.get().error).toMatch(/Too big/);

    media.sizes.set(big.uri, 4321);
    await a.add('library');
    expect(a.store.get().drafts[0]).toMatchObject({ size: 4321, status: 'ready' });
  });

  it("a file whose size can't be read is refused, not uploaded blind", async () => {
    const { ctx, a, media } = setup(() => song({ size: 0 }));
    await a.add('audio');
    expect(ctx.transport.uploads).toHaveLength(0);
    expect(a.store.get()).toMatchObject({ drafts: [], error: "Couldn't read this file. Pick it again." });
    expect(media.discarded).toEqual([song().uri]);
  });

  it(`takes at most ${MAX_ATTACHMENTS} per message`, async () => {
    const { a, media } = setup();
    for (let i = 0; i < MAX_ATTACHMENTS; i++) await a.add('library');
    await a.add('library');
    expect(media.sources).toHaveLength(MAX_ATTACHMENTS); // the picker didn't even open
    expect(a.store.get().drafts).toHaveLength(MAX_ATTACHMENTS);
    expect(a.store.get().error).toMatch(/At most 10/);
  });

  it('a cancelled pick adds nothing; a picker error shows', async () => {
    let next: PickedFile | null = null;
    const { a } = setup(() => {
      if (next === null) return null;
      throw new Error('EDITH needs the camera permission');
    });
    await a.add('camera');
    expect(a.store.get()).toMatchObject({ drafts: [], picking: false, error: null });
    next = photo();
    await a.add('camera');
    expect(a.store.get()).toMatchObject({ drafts: [], picking: false, error: 'EDITH needs the camera permission' });
  });

  it('removing a draft mid-upload cancels the upload and deletes its file', async () => {
    const { ctx, a, media } = setup();
    held(ctx);
    const adding = a.add('library');
    await flush();
    a.remove(a.store.get().drafts[0]!.key);
    await adding;
    expect(ctx.transport.cancelledUploads).toBe(1);
    expect(a.store.get().drafts).toEqual([]);
    expect(media.discarded).toEqual([photo().uri]);
  });

  it('removing a ready draft deletes its file; dispose cancels uploads in flight', async () => {
    const { ctx, a, media } = setup();
    await a.add('library');
    a.remove(a.store.get().drafts[0]!.key);
    expect(media.discarded).toEqual([photo().uri]);
    held(ctx);
    const adding = a.add('library');
    await flush();
    a.dispose();
    await adding;
    expect(ctx.transport.cancelledUploads).toBe(1);
  });
});

describe('pruning picked files (adapters/media/expo/prune.ts)', () => {
  const DAY = 86400_000;
  const now = 100 * DAY;
  it('deletes files older than the keep time, then the oldest over the size budget', () => {
    const files = [
      { n: 'new', size: 60, mtime: now - 1000 },
      { n: 'mid', size: 60, mtime: now - DAY },
      { n: 'old-but-recent', size: 60, mtime: now - 2 * DAY },
      { n: 'expired', size: 1, mtime: now - 9 * DAY },
    ];
    expect(toPrune(files, now, 8 * DAY, 150).map((f) => f.n)).toEqual(['old-but-recent', 'expired']);
    expect(toPrune(files, now, 8 * DAY, 1000).map((f) => f.n)).toEqual(['expired']);
    expect(toPrune([], now)).toEqual([]);
  });
});

describe('a message with attachments', () => {
  const STATUS = { main: 'idle', queued: 0, runs: [], tmux: 'running', conversation: true, session: null };
  const EMPTY_PAGE = { session_id: 's1', events: [], start: 's1:0', cursor: 's1:9', more: false, reset: false };
  const nowS = () => Date.now() / 1000;
  const sent = (uploaded = nowS()): SentAttachment[] => [{ id: 'att_1', name: 'p.jpg', kind: 'image', uri: 'file:///cache/attachments/p.jpg', uploaded }];
  const models: { dispose(): void }[] = [];
  afterEach(() => models.splice(0).forEach((m) => m.dispose()));

  function live(storage = new MemoryStorage()) {
    const ctx = fakeContext();
    ctx.transport.on('GET /v1/status', STATUS).on('GET /v1/sessions/current/history?limit=100', EMPTY_PAGE);
    const m = createLiveModel(ctx.bus, ctx.api, storage);
    models.push(m);
    return { ctx, m, storage };
  }

  it('posts the ids (text may be empty) and shows the thumbnail on its bubble', async () => {
    const { ctx, m } = live();
    ctx.transport.on('POST /v1/messages', { ref: 'app:1', lane: 'main' });
    const list = sent();
    await m.send('', { attachments: list });
    expect(ctx.transport.calls.find((c) => c.path === '/v1/messages')?.body).toEqual({ text: '', attachments: ['att_1'] });
    expect(users(m.store.get())[0]).toMatchObject({ text: '', attachments: list, local: { status: 'sent' } });
  });

  it('a message without attachments posts no attachments field', async () => {
    const { ctx, m } = live();
    ctx.transport.on('POST /v1/messages', { ref: 'app:1', lane: 'main' });
    await m.send('hi');
    expect(ctx.transport.calls.find((c) => c.path === '/v1/messages')?.body).toEqual({ text: 'hi' });
  });

  it('keeps the attachments (with their local uri) in the outbox while it waits', async () => {
    const { ctx, m, storage } = live();
    ctx.transport.on('POST /v1/messages', () => {
      throw new ApiError(0, 'network');
    });
    const list = sent();
    await m.send('look', { attachments: list });
    await flush();
    const saved = JSON.parse((await storage.get(OUTBOX_KEY)) ?? '[]') as { attachments: unknown }[];
    expect(saved[0]?.attachments).toEqual(list);
  });

  it('an outbox message whose attachment ids are past their 7 days says "re-attach", with no retry', () => {
    const now = 2_000_000_000;
    const entry = (over: Partial<OutboxEntry>): OutboxEntry => ({ key: 'k1', text: 'look', voice: false, ts: now - 60, status: 'waiting', error: null, ref: null, delivery: null, attachments: sent(now - ID_LIFETIME_S), ...over });
    const s = restoreOutbox(initialLive, [entry({})], now);
    expect(users(s)[0]?.local).toEqual({ key: 'k1', status: 'failed', error: ATTACHMENT_EXPIRED, final: true });
    expect(outboxOf(s)[0]).toMatchObject({ final: true }); // stays final after the next restart too

    // Old outboxes have no upload time: the message's own time stands in. Fresh ones are untouched.
    const legacy = restoreOutbox(initialLive, [entry({ ts: now - ID_LIFETIME_S, attachments: [{ id: 'att_1', name: 'p.jpg', kind: 'image', uri: null }] })], now);
    expect(users(legacy)[0]?.local).toMatchObject({ error: ATTACHMENT_EXPIRED, final: true });
    const fresh = restoreOutbox(initialLive, [entry({ attachments: sent(now - 3600) })], now);
    expect(users(fresh)[0]?.local).toMatchObject({ status: 'waiting' });
  });

  it("an expired attachment isn't sent at all, and retry does nothing", async () => {
    const { ctx, m } = live();
    ctx.transport.on('POST /v1/messages', { ref: 'app:1', lane: 'main' });
    await m.send('look', { attachments: sent(nowS() - ID_LIFETIME_S - 1) });
    expect(ctx.transport.calls.filter((c) => c.path === '/v1/messages')).toHaveLength(0);
    const item = users(m.store.get())[0]!;
    expect(item.local).toMatchObject({ status: 'failed', error: ATTACHMENT_EXPIRED, final: true });
    await m.retry(item.local!.key);
    expect(ctx.transport.calls.filter((c) => c.path === '/v1/messages')).toHaveLength(0);
  });

  it('the server\'s "unknown attachment" 400 (expired or evicted id) is final too', async () => {
    const { ctx, m } = live();
    ctx.transport.on('POST /v1/messages', () => {
      throw new ApiError(400, 'unknown attachment att_1');
    });
    await m.send('look', { attachments: sent() });
    expect(users(m.store.get())[0]?.local).toMatchObject({ status: 'failed', error: ATTACHMENT_EXPIRED, final: true });
  });

  it("keeps this phone's thumbnail when the echo and the history copy arrive", async () => {
    const { ctx, m } = live();
    ctx.transport.on('POST /v1/messages', { ref: 'app:1', lane: 'main' });
    const list = sent();
    await m.send('look', { attachments: list });
    const echo = ev('message.user', { ref: 'app:1', text: 'look', delivery: 'main', attachments: ['/home/ubuntu/edith/inbox/p.jpg'] }, { origin: 'app' });
    ctx.bus.publish(echo);
    expect(users(m.store.get())).toHaveLength(1);
    expect(users(m.store.get())[0]?.attachments).toEqual(list);
    const s = fromHistory(m.store.get(), { ...EMPTY_PAGE, events: [echo] });
    expect(users(s)).toHaveLength(1);
    expect(users(s)[0]?.attachments).toEqual(list);
  });

  it('shows names for attachments from Telegram or history (no local file)', () => {
    const s = reduce(initialLive, ev('message.user', { ref: 't:1', text: '', attachments: ['/inbox/voice.ogg', '/inbox/IMG_1.jpg', ''] }, { origin: 'telegram' }));
    expect(users(s)[0]?.attachments).toEqual([
      { id: '', name: 'voice.ogg', kind: 'audio', uri: null },
      { id: '', name: 'IMG_1.jpg', kind: 'image', uri: null },
    ]);
  });
});
