// Settings: the grouped list with live summaries, a row opening its page, and back (the header's
// button, and Android back only while Settings is the screen on top).

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler, Text } from 'react-native';

import { localEvent } from '../../core/events';
import { loadFeatures } from '../../core/feature';
import { features } from '../../features';
import type { FrameMeter } from '../../core/ports';
import { createStore } from '../../core/store';
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
  const page = createStore<string | null>(null);
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<SettingsScreen connection={ctx.connection} sections={loaded.settings} meter={null} open={page} />);
  });
  const row = (label: string) => r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith(label) && typeof n.props.onPress === 'function')[0]!;
  return { ctx, r, loaded, back, row, page };
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

  it('reads well with TalkBack: rows say what they open, the page title is a heading beside Back', async () => {
    const { r, loaded, row } = await mount();
    expect(row('Push').props.accessibilityHint).toBe('Opens Push');
    await act(async () => row('Updates').props.onPress());
    const button = row('Back to Settings');
    expect(button.findAll((n) => n.type === Text && n.props.children === 'Updates')).toHaveLength(0); // the name isn't swallowed by the button
    const heading = r.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header' && n.props.children === 'Updates');
    expect(heading).toHaveLength(1);
    act(() => r.unmount());
    loaded.cleanup();
  });

  it('shows the page the shell asks for (or the list), whatever was open before', async () => {
    const { r, loaded, row, page } = await mount();
    await act(async () => row('Updates').props.onPress());
    await act(async () => page.set('Server connection')); // e.g. the token-rejected pill
    expect(texts(r)).toContain('Change server');
    await act(async () => page.set(null)); // Settings opened by a link: the list
    expect(texts(r)).not.toContain('Change server');
    expect(texts(r)).toContain('Notifications');
    act(() => r.unmount());
    loaded.cleanup();
  });

  it('has no leftover Performance heading on the Developer page', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    fakeBack();
    const ctx = fakeContext();
    const meter = { start: () => {}, stop: async () => null } as unknown as FrameMeter;
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<SettingsScreen connection={ctx.connection} sections={[]} meter={meter} />);
    });
    const open = r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Developer') && typeof n.props.onPress === 'function')[0]!;
    await act(async () => open.props.onPress());
    expect(texts(r)).toContain('Measure frames');
    expect(texts(r)).not.toMatch(/performance/i);
    act(() => r.unmount());
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
