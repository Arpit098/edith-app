import { localEvent } from '../../../core/events';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createSessionsModel } from '../model';

const LIST = {
  sessions: [
    { session_id: 's1', title: 'youtube automation', updated: 1_800_000_000, current: true },
    { session_id: 's2', title: null, updated: 1_799_990_000, current: false },
  ],
};

function setup() {
  const ctx = fakeContext();
  const notes: string[] = [];
  ctx.transport.on('GET /v1/sessions', LIST);
  const m = createSessionsModel(ctx.bus, ctx.api, (t) => notes.push(t));
  return { ctx, m, notes };
}

describe('sessions model', () => {
  it('loads on connect and collapses overlapping refreshes', async () => {
    const { ctx, m } = setup();
    ctx.bus.publish(localEvent('app.connected', { first: true }));
    void m.refresh();
    void m.refresh();
    await m.refresh();
    await flush();
    const gets = ctx.transport.calls.filter((c) => c.path === '/v1/sessions');
    expect(gets).toHaveLength(2); // the first, plus one for everything asked meanwhile
    expect(m.store.get()).toMatchObject({ loading: false, error: null });
    expect(m.store.get().list.map((s) => s.session_id)).toEqual(['s1', 's2']);
  });

  it('keeps the list and shows the error when a refresh fails', async () => {
    const { ctx, m } = setup();
    await m.refresh();
    ctx.transport.on('GET /v1/sessions', () => {
      throw new Error('timed out');
    });
    await m.refresh();
    expect(m.store.get().list).toHaveLength(2);
    expect(m.store.get().error).toBe('timed out');
  });

  it('switches: shows its messages and ends on session.switched', async () => {
    const { ctx, m, notes } = setup();
    ctx.transport.on('POST /v1/sessions/s2/resume', { status: 'switching', ref: 'app:switch:s2:1' });
    expect(await m.resume('s2')).toBeNull();
    expect(m.store.get().switching).toEqual({ ref: 'app:switch:s2:1', id: 's2' });
    expect(await m.resume('s1')).toBe('Already switching…');

    ctx.bus.publish(ev('command.reply', { ref: 'other', text: 'not ours' }));
    ctx.bus.publish(ev('command.reply', { ref: 'app:switch:s2:1', text: '🔄 Switching to: s2…' }));
    ctx.bus.publish(ev('command.reply', { ref: 'app:switch:s2:1', text: '▶️ Switched. Carry on where we left off.' }));
    ctx.bus.publish(ev('session.changed', { session_id: 's2', title: null, source: 'resume' }));
    expect(m.store.get().switching).not.toBeNull(); // only session.switched ends it
    ctx.bus.publish(ev('session.switched', { ref: 'app:switch:other', result: 'ok' }));
    expect(m.store.get().switching).not.toBeNull();
    ctx.bus.publish(ev('session.switched', { ref: 'app:switch:s2:1', result: 'ok', session_id: 's2' }));
    expect(m.store.get().switching).toBeNull();
    expect(notes).toEqual(['🔄 Switching to: s2…', '▶️ Switched. Carry on where we left off.']);
  });

  it('handles a switch that ends before its POST answers', async () => {
    const { ctx, m, notes } = setup();
    ctx.transport.on('POST /v1/sessions/s2/resume', () => {
      // the worker answers "busy" at once: its events reach the app first
      ctx.bus.publish(ev('command.reply', { ref: 'app:switch:s2:2', text: "⚠️ I'm in the middle of a task." }));
      ctx.bus.publish(ev('session.switched', { ref: 'app:switch:s2:2', result: 'busy', session_id: null }));
      return { status: 'switching', ref: 'app:switch:s2:2' };
    });
    expect(await m.resume('s2')).toBeNull();
    expect(m.store.get().switching).toBeNull();
    expect(notes).toEqual(["⚠️ I'm in the middle of a task."]);
  });

  it('starts new conversations, or says why not', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/sessions/new', { result: 'busy' });
    expect(await m.newSession()).toMatch(/middle of a task/);
    ctx.transport.on('POST /v1/sessions/new', { result: 'ok' });
    expect(await m.newSession()).toBe('🆕 Fresh conversation started');
  });

  it('renames in place', async () => {
    const { ctx, m } = setup();
    await m.refresh();
    ctx.transport.on('PATCH /v1/sessions/s2', { session_id: 's2', title: 'disk cleanup' });
    expect(await m.rename('s2', '  ')).toBe('Enter a name');
    expect(await m.rename('s2', ' disk cleanup ')).toBeNull();
    expect(ctx.transport.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { title: 'disk cleanup' } });
    expect(m.store.get().list[1]?.title).toBe('disk cleanup');
  });
});
