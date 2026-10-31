// Settings → Claude accounts draws the list, confirms a switch, and shows the sign-in form.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Modal, Text, TextInput } from 'react-native';

import { fakeContext } from '../../../testing/fakes';
import { AccountsSection } from '../AccountsSection';
import { createAccountsModel } from '../model';

jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

function texts(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).filter((c) => typeof c === 'string').join(''))
    .join(' | ');
}

const press = (r: ReactTestRenderer, label: string) =>
  r.root.find((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function' && texts({ root: n } as ReactTestRenderer).includes(label)).props.onPress();

describe('AccountsSection', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {})); // react-test-renderer is deprecated in React 19

  it('lists the accounts, confirms a switch and shows the sign-in form', async () => {
    const ctx = fakeContext();
    ctx.transport
      .on('GET /v1/accounts', {
        accounts: [
          { id: 'aaaa1111', label: 'Personal', email: 'me@example.com', plan: 'max', active: true },
          { id: 'bbbb2222', label: 'Work', email: 'work@example.com', plan: 'pro', active: false },
        ],
        switch: null,
        login: null,
      })
      .on('POST /v1/accounts/login', { id: 'l1', url: 'https://claude.com/cai/oauth/authorize?x=1' });
    const model = createAccountsModel(ctx.bus, ctx.api);
    await model.refresh();
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<AccountsSection model={model} />);
    });
    const shown = texts(r);
    for (const part of ['Personal', 'me@example.com · Max · in use', 'Work', 'work@example.com · Pro']) expect(shown).toContain(part);

    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await act(async () => press(r, 'Switch'));
    expect(alert.mock.calls[0]![0]).toBe('Switch to Work?');
    expect(alert.mock.calls[0]![1]).toMatch(/restarts EDITH and the coding agents.*about 30 seconds/);

    await act(async () => {
      await model.startLogin();
    });
    expect(texts(r)).toContain('https://claude.com/cai/oauth/authorize?x=1');
    expect(r.root.findAllByType(TextInput)).toHaveLength(2);
    act(() => r.unmount());
  });

  it('renames from the pencil or a long press, in a small dialog', async () => {
    const ctx = fakeContext();
    let accounts = [
      { id: 'aaaa1111', label: 'Personal', email: 'me@example.com', plan: 'max', active: true },
      { id: 'bbbb2222', label: 'Work', email: 'work@example.com', plan: 'pro', active: false },
    ];
    ctx.transport
      .on('GET /v1/accounts', () => ({ accounts, switch: null, login: null }))
      .on('PATCH /v1/accounts/aaaa1111', (body: { label: string }) => {
        accounts = accounts.map((a) => (a.id === 'aaaa1111' ? { ...a, label: body.label } : a));
        return { account: accounts[0] };
      });
    const model = createAccountsModel(ctx.bus, ctx.api);
    await model.refresh();
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<AccountsSection model={model} />);
    });
    const byLabel = (label: string) => r.root.findAll((n) => n.props.accessibilityLabel === label && (n.props.onPress || n.props.onLongPress))[0]!;
    const nameInput = () => r.root.findAllByType(TextInput).find((n) => n.props.accessibilityLabel === 'New name');

    // The account in use can be renamed too (renaming never touches its login).
    await act(async () => byLabel('Rename Personal').props.onPress());
    expect(r.root.findAllByType(Modal)).toHaveLength(1);
    expect(nameInput()!.props.value).toBe('Personal');
    act(() => nameInput()!.props.onChangeText(' '));
    await act(async () => press(r, 'Save'));
    expect(texts(r)).toContain('Enter a name.');
    act(() => nameInput()!.props.onChangeText('  Home max '));
    await act(async () => press(r, 'Save'));
    expect(ctx.transport.calls.filter((c) => c.method === 'PATCH')).toEqual([{ method: 'PATCH', path: '/v1/accounts/aaaa1111', body: { label: 'Home max' } }]);
    expect(r.root.findAllByType(Modal)).toHaveLength(0);
    expect(texts(r)).toContain('Home max');

    await act(async () => byLabel('Work').props.onLongPress());
    expect(nameInput()!.props.value).toBe('Work');
    await act(async () => press(r, 'Cancel'));
    expect(r.root.findAllByType(Modal)).toHaveLength(0);
    expect(ctx.transport.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    act(() => r.unmount());
  });
});
