// Settings: the grouped list with live summaries, a row opening its page, and back (the header's
// button, and Android back only while Settings is the screen on top).

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler, Text } from 'react-native';

import { localEvent } from '../../core/events';
import { loadFeatures } from '../../core/feature';
import { features } from '../../features';
import { fakeContext } from '../../testing/fakes';
import { SettingsScreen } from '../SettingsScreen';

jest.mock('../../ui/toast', () => ({ toast: jest.fn() }));
jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

function texts(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).filter((c) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

/** BackHandler as Android runs it: the newest listener first, until one returns true. */
function fakeBack() {
  const listeners: (() => boolean)[] = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, handler) => {
    listeners.push(handler as () => boolean);
    return { remove: () => void listeners.splice(listeners.indexOf(handler as () => boolean), 1) };
  });
  return { press: () => [...listeners].reverse().some((l) => l()), count: () => listeners.length };
}

async function mount() {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  const back = fakeBack();
  const ctx = fakeContext();
  ctx.transport.on('GET /v1/status', { main: 'idle', queued: 0, runs: [], tmux: 'running', conversation: true, session: null });
  await act(() => ctx.connection.connect('http://edith:8787', 'x'.repeat(40)));
  await act(async () => ctx.transport.status({ state: 'open' }));
  const loaded = loadFeatures(features, ctx);
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<SettingsScreen connection={ctx.connection} sections={loaded.settings} meter={null} />);
  });
  const row = (label: string) => r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith(label) && typeof n.props.onPress === 'function')[0]!;
  return { ctx, r, loaded, back, row };
}

describe('SettingsScreen', () => {
  it('lists the groups with each row’s title and live summary', async () => {
    const { r, loaded, row } = await mount();
    const shown = texts(r);
    const order = ['Connection & account', 'Server connection', 'Claude accounts', 'Notifications', 'Push', 'Live Alerts', 'Voice', 'Voice input', 'Wake word', 'App', 'Updates'];
    const at = order.map((t) => shown.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(shown).not.toContain('Developer'); // no frame meter on this phone
    expect(row('Server connection').props.accessibilityLabel).toBe('Server connection, Connected · edith');
    expect(row('Push').props.accessibilityLabel).toBe('Push, Not available on this phone'); // no native push service in tests
    expect(shown).not.toContain('Change server'); // sections wait on their own pages
    act(() => r.unmount());
    loaded.cleanup();
  });

  it('opens a row on its own page, and goes back with the header button or Android back', async () => {
    const { r, loaded, back, row } = await mount();
    const before = back.count();
    await act(async () => row('Server connection').props.onPress());
    expect(texts(r)).toContain('Change server');
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'header' && n.props.children === 'Server connection')).not.toHaveLength(0);
    await act(async () => row('Back to Settings').props.onPress());
    expect(texts(r)).not.toContain('Change server');
    expect(texts(r)).toContain('Notifications');

    await act(async () => row('Server connection').props.onPress());
    expect(back.count()).toBe(before + 1);
    let handled = false;
    await act(async () => {
      handled = back.press();
    });
    expect(handled).toBe(true);
    expect(texts(r)).not.toContain('Change server');
    expect(back.count()).toBe(before); // nothing left to close: the shell decides again
    act(() => r.unmount());
    loaded.cleanup();
  });

  it('leaves Android back to the shell while another screen is on top', async () => {
    const { ctx, r, loaded, back, row } = await mount();
    const before = back.count();
    await act(async () => row('Updates').props.onPress());
    await act(async () => ctx.bus.publish(localEvent('app.screen', { name: 'live' })));
    expect(back.count()).toBe(before); // hidden behind Live: its page doesn't take the press
    await act(async () => ctx.bus.publish(localEvent('app.screen', { name: 'settings' })));
    expect(back.count()).toBe(before + 1); // back on Settings, still on the Updates page
    act(() => r.unmount());
    loaded.cleanup();
  });
});
