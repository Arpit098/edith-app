// Settings → Claude accounts draws the list, confirms a switch, and shows the sign-in form.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Text, TextInput } from 'react-native';

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
});
