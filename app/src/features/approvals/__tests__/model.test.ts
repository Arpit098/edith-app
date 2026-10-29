import { ApiError } from '../../../core/api';
import { localEvent } from '../../../core/events';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createApprovalsModel } from '../model';

const REQ = { id: 'ab12', tool: 'Bash', detail: 'rm -rf build', ref: 'app:1', lane: 'main' as const };

describe('approvals model', () => {
  it('follows requests and resolutions from the stream', () => {
    const ctx = fakeContext();
    const m = createApprovalsModel(ctx.bus, ctx.api);
    ctx.bus.publish(ev('permission.request', REQ));
    ctx.bus.publish(ev('permission.request', REQ)); // duplicate
    ctx.bus.publish(ev('permission.request', { ...REQ, id: 'cd34' }));
    expect(m.store.get().pending.map((p) => p.id)).toEqual(['ab12', 'cd34']);
    ctx.bus.publish(ev('permission.resolved', { id: 'ab12', decision: 'gone' }));
    expect(m.store.get().pending.map((p) => p.id)).toEqual(['cd34']);
  });

  it('resyncs from /v1/permissions on connect', async () => {
    const ctx = fakeContext();
    ctx.transport.on('GET /v1/permissions', { pending: [REQ] });
    const m = createApprovalsModel(ctx.bus, ctx.api);
    ctx.bus.publish(ev('permission.request', { ...REQ, id: 'old' }));
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(m.store.get().pending).toEqual([REQ]);
  });

  it('answers, and handles expired and failed answers', async () => {
    const ctx = fakeContext();
    let fail: Error | null = null;
    ctx.transport.on('POST /v1/permissions/ab12', (body: unknown) => {
      if (fail) throw fail;
      return { id: 'ab12', decision: (body as { allow: boolean }).allow ? 'allow' : 'deny' };
    });
    const m = createApprovalsModel(ctx.bus, ctx.api);
    ctx.bus.publish(ev('permission.request', REQ));

    fail = new ApiError(0, 'timed out');
    expect(await m.answer('ab12', true)).toBe("Couldn't answer: timed out");
    expect(m.store.get()).toEqual({ pending: [REQ], answering: {} });

    fail = null;
    expect(await m.answer('ab12', false)).toBe('❌ Denied');
    expect(ctx.transport.calls.at(-1)?.body).toEqual({ allow: false });
    expect(m.store.get().pending).toEqual([]);

    ctx.bus.publish(ev('permission.request', REQ));
    fail = new ApiError(404, 'That request has expired.');
    expect(await m.answer('ab12', true)).toBe('That request has expired.');
    expect(m.store.get().pending).toEqual([]);
  });

  it('ignores a second tap while sending', async () => {
    const ctx = fakeContext();
    let release: (v: unknown) => void = () => {};
    ctx.transport.on('POST /v1/permissions/ab12', () => new Promise((r) => (release = r)));
    const m = createApprovalsModel(ctx.bus, ctx.api);
    ctx.bus.publish(ev('permission.request', REQ));
    const first = m.answer('ab12', true);
    expect(await m.answer('ab12', true)).toBe('Already sending…');
    release({ id: 'ab12', decision: 'allow' });
    expect(await first).toBe('✅ Allowed');
    expect(ctx.transport.calls).toHaveLength(1);
  });
});
