// Attachments: upload at once with progress, limits, the 404 "server update" message, retry, remove,
// and a message sent with attachment ids that keeps its thumbnails.

import { ApiError } from '../../../core/api';
import type { MediaPicker, PickedFile } from '../../../core/ports';
import { ev, fakeContext, flush, MemoryStorage } from '../../../testing/fakes';
import { createAttachmentsModel, MAX_ATTACHMENTS, MAX_IMAGE_BYTES, uploadError } from '../attachments';
import { createLiveModel, fromHistory, initialLive, OUTBOX_KEY, reduce, type Item, type LiveState } from '../model';

type User = Extract<Item, { kind: 'user' }>;
const users = (s: LiveState) => s.items.filter((x): x is User => x.kind === 'user');

const photo = (over: Partial<PickedFile> = {}): PickedFile => ({ kind: 'image', uri: 'file:///cache/p.jpg', name: 'p.jpg', mime: 'image/jpeg', size: 1000, ...over });
const song = (over: Partial<PickedFile> = {}): PickedFile => ({ kind: 'audio', uri: 'file:///cache/a.m4a', name: 'a.m4a', mime: 'audio/mp4', size: 2000, ...over });

function picker(next: () => PickedFile | null | Promise<PickedFile | null>): MediaPicker & { sources: string[] } {
  const sources: string[] = [];
  return {
    sources,
    pickImage: async (source) => (sources.push(source), next()),
    pickAudio: async () => (sources.push('audio'), next()),
  };
}

function setup(next: () => PickedFile | null | Promise<PickedFile | null> = () => photo()) {
  const ctx = fakeContext();
  let n = 0;
  ctx.transport.on('UPLOAD /v1/attachments', (f: { name: string; mime: string }) => ({ id: `att_${++n}`, name: f.name, type: f.mime, size: 1000, sha256: 'x' }));
  const media = picker(next);
  let t = 0;
  const a = createAttachmentsModel({ api: ctx.api, media, now: () => (t += 1000) });
  return { ctx, a, media };
}

describe('attachments in the composer', () => {
  it('uploads a picked photo at once and is ready to send with its id', async () => {
    const { ctx, a, media } = setup();
    await a.add('camera');
    expect(media.sources).toEqual(['camera']);
    expect(ctx.transport.uploads).toEqual([{ path: '/v1/attachments', file: expect.objectContaining({ uri: 'file:///cache/p.jpg', mime: 'image/jpeg', name: 'p.jpg' }), field: 'raw' }]);
    expect(a.store.get().drafts[0]).toMatchObject({ status: 'ready', id: 'att_1', error: null });
    expect(a.ready()).toEqual([{ id: 'att_1', name: 'p.jpg', kind: 'image', uri: 'file:///cache/p.jpg' }]);
    expect(a.busy()).toBe(false);
  });

  it('shows progress while uploading, and is busy until done', async () => {
    const { ctx, a } = setup();
    let finish: (v: unknown) => void = () => {};
    ctx.transport.on('UPLOAD /v1/attachments', () => new Promise((r) => (finish = r)));
    const adding = a.add('library');
    await flush();
    expect(a.store.get().drafts[0]).toMatchObject({ status: 'uploading', sent: 50, total: 100 });
    expect(a.busy()).toBe(true);
    expect(a.ready()).toEqual([]); // nothing goes out half-uploaded
    finish({ id: 'att_9', name: 'p.jpg', type: 'image/jpeg', size: 1000, sha256: 'x' });
    await adding;
    expect(a.ready().map((x) => x.id)).toEqual(['att_9']);
  });

  it('says plainly when the server has no /v1/attachments yet (404), and retries', async () => {
    const { ctx, a } = setup(() => song());
    ctx.transport.on('UPLOAD /v1/attachments', () => {
      throw new ApiError(404, 'not found');
    });
    await a.add('audio');
    expect(a.store.get().drafts[0]).toMatchObject({ kind: 'audio', status: 'failed', error: 'Attachments need a server update on edith.' });
    expect(a.ready()).toEqual([]);

    ctx.transport.on('UPLOAD /v1/attachments', () => ({ id: 'att_7', name: 'a.m4a', type: 'audio/mp4', size: 2000, sha256: 'x' }));
    await a.retry(a.store.get().drafts[0]!.key);
    expect(a.store.get().drafts[0]).toMatchObject({ status: 'ready', id: 'att_7', error: null });
  });

  it('maps the contract errors to plain messages', () => {
    expect(uploadError(new ApiError(415, 'x'))).toMatch(/doesn't take this kind of file/);
    expect(uploadError(new ApiError(413, 'x'))).toMatch(/Too big/);
    expect(uploadError(new ApiError(0, 'timed out'))).toMatch(/took too long/);
    expect(uploadError(new ApiError(0, 'network'))).toMatch(/Tailscale/);
    expect(uploadError(new ApiError(400, 'unknown attachment att_1'))).toBe('Upload failed: unknown attachment att_1');
  });

  it('refuses a file over the limit before uploading it', async () => {
    const { ctx, a } = setup(() => photo({ size: MAX_IMAGE_BYTES + 1 }));
    await a.add('library');
    expect(ctx.transport.uploads).toHaveLength(0);
    expect(a.store.get()).toMatchObject({ drafts: [], picking: false, error: expect.stringMatching(/Too big/) });
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

  it('removes a draft, even mid-upload (its late answer is ignored)', async () => {
    const { ctx, a } = setup();
    let finish: (v: unknown) => void = () => {};
    ctx.transport.on('UPLOAD /v1/attachments', () => new Promise((r) => (finish = r)));
    const adding = a.add('library');
    await flush();
    a.remove(a.store.get().drafts[0]!.key);
    finish({ id: 'att_1', name: 'p.jpg', type: 'image/jpeg', size: 1, sha256: 'x' });
    await adding;
    expect(a.store.get().drafts).toEqual([]);
    a.clear();
    expect(a.ready()).toEqual([]);
  });
});

describe('a message with attachments', () => {
  const STATUS = { main: 'idle', queued: 0, runs: [], tmux: 'running', conversation: true, session: null };
  const EMPTY_PAGE = { session_id: 's1', events: [], start: 's1:0', cursor: 's1:9', more: false, reset: false };
  const sent = [{ id: 'att_1', name: 'p.jpg', kind: 'image' as const, uri: 'file:///cache/p.jpg' }];
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
    await m.send('', { attachments: sent });
    expect(ctx.transport.calls.find((c) => c.path === '/v1/messages')?.body).toEqual({ text: '', attachments: ['att_1'] });
    expect(users(m.store.get())[0]).toMatchObject({ text: '', attachments: sent, local: { status: 'sent' } });
  });

  it('a message without attachments posts no attachments field', async () => {
    const { ctx, m } = live();
    ctx.transport.on('POST /v1/messages', { ref: 'app:1', lane: 'main' });
    await m.send('hi');
    expect(ctx.transport.calls.find((c) => c.path === '/v1/messages')?.body).toEqual({ text: 'hi' });
  });

  it('keeps the attachments in the outbox while it waits', async () => {
    const { ctx, m, storage } = live();
    ctx.transport.on('POST /v1/messages', () => {
      throw new ApiError(0, 'network');
    });
    await m.send('look', { attachments: sent });
    await flush();
    const saved = JSON.parse((await storage.get(OUTBOX_KEY)) ?? '[]') as { attachments: unknown }[];
    expect(saved[0]?.attachments).toEqual(sent);
  });

  it("keeps this phone's thumbnail when the echo and the history copy arrive", async () => {
    const { ctx, m } = live();
    ctx.transport.on('POST /v1/messages', { ref: 'app:1', lane: 'main' });
    await m.send('look', { attachments: sent });
    const echo = ev('message.user', { ref: 'app:1', text: 'look', delivery: 'main', attachments: ['/home/ubuntu/edith/inbox/p.jpg'] }, { origin: 'app' });
    ctx.bus.publish(echo);
    expect(users(m.store.get())).toHaveLength(1);
    expect(users(m.store.get())[0]?.attachments).toEqual(sent);
    const s = fromHistory(m.store.get(), { ...EMPTY_PAGE, events: [echo] });
    expect(users(s)).toHaveLength(1);
    expect(users(s)[0]?.attachments).toEqual(sent);
  });

  it('shows names for attachments from Telegram or history (no local file)', () => {
    const s = reduce(initialLive, ev('message.user', { ref: 't:1', text: '', attachments: ['/inbox/voice.ogg', '/inbox/IMG_1.jpg', ''] }, { origin: 'telegram' }));
    expect(users(s)[0]?.attachments).toEqual([
      { id: '', name: 'voice.ogg', kind: 'audio', uri: null },
      { id: '', name: 'IMG_1.jpg', kind: 'image', uri: null },
    ]);
  });
});
