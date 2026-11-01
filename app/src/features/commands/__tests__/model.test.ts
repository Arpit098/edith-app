import { localEvent } from '../../../core/events';
import { ev, fakeContext, flush, MemoryStorage } from '../../../testing/fakes';
import { createCommandsModel, RECENT_KEY } from '../model';

const COMMANDS = {
  commands: [
    { name: 'today', description: "Today's calendar", usage: '', help: 'calendar' },
    { name: 'queue', description: 'Run after the current task', usage: '<task>', help: 'queue' },
    { name: 'help', description: 'Help', usage: '', help: 'this message' },
  ],
};

function setup() {
  const ctx = fakeContext();
  ctx.transport.on('GET /v1/commands', COMMANDS);
  return { ctx, m: createCommandsModel(ctx.bus, ctx.api) };
}

describe('commands model', () => {
  it('loads once, hides commands the app has its own UI for, and reloads after a reconnect', async () => {
    const { ctx, m } = setup();
    ctx.bus.publish(localEvent('app.connected', { first: true })); // not loaded yet: nothing to do
    await m.load();
    await m.load();
    expect(m.store.get().commands?.map((c) => c.name)).toEqual(['today', 'queue']);
    ctx.bus.publish(localEvent('app.connected', { first: false }));
    await flush();
    expect(ctx.transport.calls.filter((c) => c.path === '/v1/commands')).toHaveLength(2);
  });

  it('runs a command and shows its replies, now and later', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/commands/queue', { ref: 'app:7', replies: [{ text: 'one' }, { text: 'two', buttons: [[{ label: 'B', action: 'b:1' }]] }] });
    expect(await m.run('queue', '  deploy it ')).toBeNull();
    expect(ctx.transport.calls.at(-1)?.body).toEqual({ args: 'deploy it' });
    expect(m.store.get().output.map((o) => o.text)).toEqual(['two', 'one']);
    expect(m.store.get().running).toBeNull();

    ctx.bus.publish(ev('command.reply', { ref: 'app:7', text: 'three' }));
    ctx.bus.publish(ev('command.reply', { ref: 'app:other', text: 'nope' }));
    expect(m.store.get().output.map((o) => o.text)).toEqual(['three', 'two', 'one']);
  });

  it('presses buttons and reports failures', async () => {
    const { ctx, m } = setup();
    ctx.transport.on('POST /v1/commands/today', { ref: 'app:1', replies: [{ text: 'Agenda', buttons: [[{ label: 'Refresh', action: 'quick:today' }]] }] });
    await m.run('today');
    const id = m.store.get().output[0]!.id;
    ctx.transport.on('POST /v1/actions', { ref: 'app:2', toast: 'Refreshed', note: '🔄', replies: [{ text: 'Agenda v2' }] });
    expect(await m.press(id, 'quick:today')).toBe('Refreshed');
    expect(m.store.get().output.map((o) => [o.text, o.buttons.length, o.note])).toEqual([
      ['Agenda v2', 0, null],
      ['Agenda', 0, '🔄'],
    ]);
    ctx.transport.on('POST /v1/commands/today', () => {
      throw new Error('timed out');
    });
    expect(await m.run('today')).toBe('/today failed: timed out');
  });

  it('remembers the last 3 commands run, on the phone, and restores them', async () => {
    const ctx = fakeContext();
    const data = new MemoryStorage();
    await data.set(RECENT_KEY, JSON.stringify(['mail', 7, 'brief']));
    const m = createCommandsModel(ctx.bus, ctx.api, data);
    await flush();
    expect(m.store.get().recent).toEqual(['mail', 'brief']); // junk dropped
    for (const name of ['today', 'queue', 'mail', 'today']) {
      ctx.transport.on(`POST /v1/commands/${name}`, { ref: '', replies: [] });
      await m.run(name);
    }
    ctx.transport.on('POST /v1/commands/brief', () => {
      throw new Error('down');
    });
    await m.run('brief'); // a failed run isn't "used"
    expect(m.store.get().recent).toEqual(['today', 'mail', 'queue']);
    expect(JSON.parse((await data.get(RECENT_KEY))!)).toEqual(['today', 'mail', 'queue']);

    const again = createCommandsModel(ctx.bus, ctx.api, data);
    await flush();
    expect(again.store.get().recent).toEqual(['today', 'mail', 'queue']);
    // Unreadable storage: just no recents.
    const broken = createCommandsModel(ctx.bus, ctx.api, { get: () => Promise.resolve('{nope'), set: () => Promise.reject(new Error('full')), remove: async () => {} });
    await flush();
    expect(broken.store.get().recent).toEqual([]);
    ctx.transport.on('POST /v1/commands/today', { ref: '', replies: [] });
    expect(await broken.run('today')).toBeNull(); // a failed save doesn't fail the run
    [m, again, broken].forEach((x) => x.dispose());
  });
});
