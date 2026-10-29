import { createApi } from '../api';
import { FakeTransport } from '../../testing/fakes';

describe('createApi', () => {
  it('sends messages and stops', async () => {
    const t = new FakeTransport()
      .on('POST /v1/messages', { ref: 'app:1', lane: 'main' })
      .on('POST /v1/stop', { running: 1, dropped: ['app:2'] });
    const api = createApi(t);
    expect(await api.send('hi', { voice: false })).toEqual({ ref: 'app:1', lane: 'main' });
    expect(t.calls[0]).toEqual({ method: 'POST', path: '/v1/messages', body: { text: 'hi', voice: false } });
    expect(await api.stop()).toEqual({ running: 1, dropped: ['app:2'] });
  });

  it('parses status defensively', async () => {
    const t = new FakeTransport().on('GET /v1/status', {
      main: 'busy',
      queued: 2,
      runs: [{ ref: 'r', lane: 'side', seconds: 4, step: '$ ls' }, { ref: 'q', lane: 'weird' }],
      tmux: 'running',
      conversation: true,
      session: { id: 's1', title: null },
    });
    const s = await createApi(t).status();
    expect(s.main).toBe('busy');
    expect(s.runs).toEqual([
      { ref: 'r', lane: 'side', seconds: 4, step: '$ ls' },
      { ref: 'q', lane: 'main', seconds: 0, step: null },
    ]);
    expect(s.session).toEqual({ id: 's1', title: null });
  });

  it('lists, resumes, renames and creates sessions with encoded ids', async () => {
    const t = new FakeTransport()
      .on('GET /v1/sessions', { sessions: [{ session_id: 'a/b', title: 'T', updated: 5, current: true }, { session_id: 'c' }] })
      .on('POST /v1/sessions/a%2Fb/resume', { status: 'switching', ref: 'app:switch:1' })
      .on('PATCH /v1/sessions/c', (body: unknown) => ({ session_id: 'c', title: (body as { title: string }).title }))
      .on('POST /v1/sessions/new', { result: 'busy' });
    const api = createApi(t);
    const list = await api.sessions();
    expect(list[1]).toEqual({ session_id: 'c', title: null, updated: 0, current: false });
    expect(await api.resume('a/b')).toEqual({ ref: 'app:switch:1' });
    expect(await api.rename('c', 'New name')).toEqual({ session_id: 'c', title: 'New name' });
    expect(await api.newSession()).toBe('busy');
  });

  it('handles permissions, actions and commands', async () => {
    const t = new FakeTransport()
      .on('GET /v1/permissions', { pending: [{ id: 'ab', tool: 'Bash', detail: 'rm', ref: null, lane: 'main' }] })
      .on('POST /v1/permissions/ab', { id: 'ab', decision: 'allow' })
      .on('POST /v1/actions', { ref: 'r', toast: 'Done', note: null, replies: [{ text: 'x', buttons: [[{ label: 'B', action: 'b:1' }]] }] })
      .on('GET /v1/commands', { commands: [{ name: 'today', description: 'Today', usage: '', help: 'calendar' }] })
      .on('POST /v1/commands/today', { ref: 'r2', replies: [{ text: 'Free all day' }] });
    const api = createApi(t);
    expect(await api.permissions()).toEqual([{ id: 'ab', tool: 'Bash', detail: 'rm', ref: null, lane: 'main' }]);
    expect(await api.answer('ab', true)).toEqual({ id: 'ab', decision: 'allow' });
    expect(t.calls.at(-1)?.body).toEqual({ allow: true });
    expect(await api.press('rem:done:1')).toEqual({
      ref: 'r',
      toast: 'Done',
      note: null,
      replies: [{ text: 'x', buttons: [[{ label: 'B', action: 'b:1' }]] }],
    });
    expect((await api.commands())[0]?.name).toBe('today');
    expect(await api.run('today')).toEqual({ ref: 'r2', replies: [{ text: 'Free all day', buttons: [] }] });
    expect(t.calls.at(-1)?.body).toEqual({});
  });
});
