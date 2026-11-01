// The Commands page: grouped rows with TalkBack labels, a tap runs it (or opens its argument field,
// or asks first for /restart), and the search filters the rows.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Text, TextInput } from 'react-native';

import { fakeContext, flush } from '../../../testing/fakes';
import { CommandsScreen } from '../CommandsScreen';
import { createCommandsModel } from '../model';

jest.mock('../../../ui/toast', () => ({ toast: jest.fn() }));
jest.setTimeout(30_000);

const COMMANDS = {
  commands: [
    { name: 'brief', description: "Today's brief: calendar, mail, reminders", usage: '', help: '' },
    { name: 'queue', description: 'Run after the current task', usage: '<task>', help: '' },
    { name: 'restart', description: 'Restart the bridge', usage: '', help: '' },
  ],
};

const texts = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).filter((c) => typeof c === 'string').join(''))
    .join(' | ');

async function mount() {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  const ctx = fakeContext();
  ctx.transport.on('GET /v1/commands', COMMANDS);
  const m = createCommandsModel(ctx.bus, ctx.api);
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<CommandsScreen model={m} />);
    await flush();
  });
  const row = (start: string) => r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith(start) && n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')[0];
  const tap = async (n: ReactTestInstance | undefined) =>
    act(async () => {
      n!.props.onPress();
      await flush();
    });
  return { ctx, m, r, row, tap };
}

describe('CommandsScreen', () => {
  it('shows sections of rows with a plain name, a line on what it does and the /command', async () => {
    const { r, row } = await mount();
    const t = texts(r);
    for (const s of ['Daily', 'Conversation', 'Server', 'Brief', "Today's brief: calendar, mail, reminders", '/brief', 'Queue', '/restart']) expect(t).toContain(s);
    expect(t.indexOf('Daily')).toBeLessThan(t.indexOf('Conversation'));
    expect(row('Brief')!.props.accessibilityLabel).toBe("Brief, /brief. Today's brief: calendar, mail, reminders");
    expect(row('Brief')!.props.accessibilityHint).toBe('Runs it');
    expect(row('Queue')!.props.accessibilityHint).toBe('Opens a field for <task>');
    act(() => r.unmount());
  });

  it('runs a plain command, opens the field for one with arguments, and asks before /restart', async () => {
    const { ctx, m, r, row, tap } = await mount();
    let answer!: (v: unknown) => void;
    ctx.transport.on('POST /v1/commands/brief', () => new Promise((res) => (answer = res)));
    await tap(row('Brief'));
    // While it runs: that row is busy, the others can't be tapped.
    expect(row('Brief')!.props.accessibilityState).toMatchObject({ busy: true });
    expect(row('Queue')!.props.accessibilityState).toMatchObject({ disabled: true, busy: false });
    await act(async () => {
      answer({ ref: 'app:1', replies: [{ text: 'Your day' }] });
      await flush();
    });
    expect(row('Queue')!.props.accessibilityState).toMatchObject({ disabled: false });
    expect(ctx.transport.calls.at(-1)?.path).toBe('/v1/commands/brief');
    expect(texts(r)).toContain('Your day');
    expect(texts(r)).toContain('Recent'); // the one just used

    await tap(row('Queue'));
    expect(row('Queue')!.props.accessibilityState.expanded).toBe(true);
    const field = r.root.findAll((n) => n.type === TextInput && n.props.placeholder === '<task>');
    expect(field).toHaveLength(1);
    ctx.transport.on('POST /v1/commands/queue', { ref: 'app:2', replies: [{ text: 'Queued' }] });
    await act(async () => {
      field[0]!.props.onChangeText('deploy');
      await flush();
    });
    await act(async () => {
      r.root.findAll((n) => n.type === TextInput && n.props.placeholder === '<task>')[0]!.props.onSubmitEditing();
      await flush();
    });
    expect(ctx.transport.calls.at(-1)).toMatchObject({ path: '/v1/commands/queue', body: { args: 'deploy' } });
    expect(r.root.findAll((n) => n.type === TextInput && n.props.placeholder === '<task>')).toHaveLength(0); // closed after it ran

    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const before = ctx.transport.calls.length;
    await tap(row('Restart'));
    expect(ctx.transport.calls).toHaveLength(before); // nothing yet
    expect(alert.mock.calls[0]![0]).toBe('Restart the bridge?');
    ctx.transport.on('POST /v1/commands/restart', { ref: 'app:3', replies: [] });
    await act(async () => {
      (alert.mock.calls[0]![2] as { text: string; onPress?: () => void }[]).find((b) => b.text === 'Restart')!.onPress!();
      await flush();
    });
    expect(ctx.transport.calls.at(-1)?.path).toBe('/v1/commands/restart');
    expect(m.store.get().recent).toEqual(['restart', 'queue', 'brief']);
    act(() => r.unmount());
  });

  it('filters by name or description, and says when nothing matches', async () => {
    const { r } = await mount();
    const search = () => r.root.findAll((n) => n.type === TextInput && n.props.accessibilityLabel === 'Search commands')[0]!;
    await act(async () => search().props.onChangeText('bridge'));
    expect(texts(r)).toContain('/restart');
    expect(texts(r)).not.toContain('/brief');
    expect(texts(r)).not.toContain('Daily');
    await act(async () => search().props.onChangeText('zzz'));
    expect(texts(r)).toContain('No commands match “zzz”.');
    const clear = r.root.findAll((n) => n.props.accessibilityLabel === 'Clear search' && typeof n.props.onPress === 'function')[0]!;
    await act(async () => clear.props.onPress());
    expect(texts(r)).toContain('/brief');
    act(() => r.unmount());
  });
});
