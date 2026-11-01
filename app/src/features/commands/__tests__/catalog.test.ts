import type { Command } from '../../../core/api';
import { matches, metaOf, sections } from '../catalog';

const cmd = (name: string, description = '', usage = ''): Command => ({ name, description, usage, help: '' });

// The server's list, in its order (server/edith/features: control, quick_actions, reminders), plus one it might add.
const SERVER = [
  cmd('menu', 'Quick action buttons'),
  cmd('brief', "Today's brief: calendar, mail, reminders"),
  cmd('mail', 'Unread emails that matter'),
  cmd('today', "Today's calendar"),
  cmd('servers', 'Server + Cracker health check'),
  cmd('changes', 'Recent file changes'),
  cmd('reminders', 'Upcoming reminders'),
  cmd('btw', 'Run in parallel', '<task>'),
  cmd('queue', 'Run after the current task', '<task>'),
  cmd('compact', 'Compact the conversation', '[instructions]'),
  cmd('status', 'What E.D.I.T.H is doing'),
  cmd('restart', 'Restart the bridge'),
  cmd('weather', 'Weather where you are'),
  cmd('ping'),
];

const layout = (s: ReturnType<typeof sections>) => s.map((x) => [x.title, x.rows.map((r) => r.command.name)]);

describe('commands catalog', () => {
  it('groups the commands in sentence-case sections, unknown ones under Other in the server order', () => {
    expect(layout(sections(SERVER))).toEqual([
      ['Daily', ['brief', 'today', 'mail', 'reminders']],
      ['Conversation', ['btw', 'queue', 'compact', 'status']],
      ['Server', ['servers', 'changes', 'restart']],
      ['Other', ['menu', 'weather', 'ping']],
    ]);
  });

  it("names each row plainly and keeps the server's description, with a fallback", () => {
    expect(metaOf(SERVER[1]!)).toMatchObject({ title: 'Brief', icon: 'text-box-outline', description: "Today's brief: calendar, mail, reminders" });
    expect(metaOf(cmd('brief'))).toMatchObject({ description: "Today's calendar, mail and reminders" });
    expect(metaOf(cmd('weather', 'Weather where you are'))).toEqual({ title: 'Weather', icon: 'console-line', group: 'other', description: 'Weather where you are' });
    expect(metaOf(cmd('restart')).confirm?.action).toBe('Restart'); // asks before interrupting EDITH
    expect(metaOf(cmd('brief')).confirm).toBeUndefined();
  });

  it('searches the name (with or without the slash), the title and the description', () => {
    const row = { command: SERVER[7]!, meta: metaOf(SERVER[7]!) }; // btw
    for (const q of ['btw', '/BTW', 'by the', 'parallel', '  ']) expect(matches(row, q)).toBe(true);
    expect(matches(row, 'mail')).toBe(false);
    expect(layout(sections(SERVER, 'calendar'))).toEqual([['Daily', ['brief', 'today']]]);
    expect(sections(SERVER, 'nothing like this')).toEqual([]);
  });

  it('shows the recent ones first, skips ones the server no longer has, and hides them while searching', () => {
    expect(layout(sections(SERVER, '', ['queue', 'gone', 'mail'])).slice(0, 2)).toEqual([
      ['Recent', ['queue', 'mail']],
      ['Daily', ['brief', 'today', 'mail', 'reminders']],
    ]);
    expect(sections(SERVER, 'queue', ['queue']).map((s) => s.title)).toEqual(['Conversation']);
  });
});
