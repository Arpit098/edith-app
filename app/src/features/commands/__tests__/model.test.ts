import { localEvent } from '../../../core/events';
import { ev, fakeContext, flush } from '../../../testing/fakes';
import { createCommandsModel } from '../model';

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
});
