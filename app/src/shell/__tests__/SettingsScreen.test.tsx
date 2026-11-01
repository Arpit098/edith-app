// Settings: the grouped list with live summaries, a row opening its page, and back (the header's
// button, and Android back only while Settings is the screen on top).

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, BackHandler, Text } from 'react-native';

import { localEvent } from '../../core/events';
import { loadFeatures } from '../../core/feature';
import { features } from '../../features';
import type { FrameMeter } from '../../core/ports';
import { createStore, useStore } from '../../core/store';
import { usePageBack } from '../../ui/pageBack';
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

async function mount(meter: FrameMeter | null = null) {
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
    r = create(<SettingsScreen connection={ctx.connection} sections={loaded.settings} meter={meter} open={page} />);
  });
  const row = (label: string) => r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith(label) && typeof n.props.onPress === 'function')[0]!;
  return { ctx, r, loaded, back, row, page };
}

describe('SettingsScreen', () => {
  it('a full-page section fills the page and takes Android back first (Appearance closes its sheet, then leaves)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const back = fakeBack();
    const ctx = fakeContext();
    let sheetOpen = true;
    function Editor() {
      usePageBack(() => {
        if (!sheetOpen) return false;
        sheetOpen = false;
        return true;
      });
      return <Text>editor</Text>;
    }
    const sections = [{ title: 'Editor', component: Editor, group: 'app' as const, layout: 'full' as const }];
    const page = createStore<string | null>('Editor');
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<SettingsScreen connection={ctx.connection} sections={sections} meter={null} open={page} />);
    });
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'header' && n.props.children === 'Editor')).not.toHaveLength(0);
    expect(r.root.findAll((n) => n.props.rim === true && n.findAll((c) => c.props.children === 'editor').length > 0)).toHaveLength(0); // no card around it
    await act(async () => void back.press());
    expect(page.get()).toBe('Editor'); // the page closed its sheet
    await act(async () => void back.press());
    expect(page.get()).toBeNull(); // then Settings left the page
    act(() => r.unmount());
  });

  it('lists the groups with each row’s title and live summary', async () => {
    const { r, loaded, row } = await mount();
    const shown = texts(r);
    const order = ['E.D.I.T.H', 'Connection', 'Claude accounts', 'Notifications', 'Push', 'Live Alerts', 'Voice', 'Voice input', 'Wake word', 'App', 'Appearance', 'Chat', 'About', 'Updates', 'Change server'];
    const at = order.map((t) => shown.indexOf(t));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(shown).not.toContain('Developer'); // no frame meter on this phone
    expect(shown).not.toContain('CONNECTION'); // sentence-case titles, no spaced caps
    // The top card is the server connection: the link in a word (the host is on its page).
    expect(row('E.D.I.T.H').props.accessibilityLabel).toBe('E.D.I.T.H, Connected');
    expect(row('E.D.I.T.H').props.accessibilityHint).toBe('Opens Server connection');
    expect(row('Push').props.accessibilityLabel).toBe('Push, Not available on this phone'); // no native push service in tests
    expect(shown).not.toContain('Address'); // sections wait on their own pages
    act(() => r.unmount());
    loaded.cleanup();
  });

  it('opens a row on its own page, and goes back with the header button or Android back', async () => {
    const { r, loaded, back, row } = await mount();
    const before = back.count();
    await act(async () => row('E.D.I.T.H').props.onPress());
    expect(texts(r)).toContain('Address');
    expect(texts(r)).toContain('http://edith:8787');
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'header' && n.props.children === 'Server connection')).not.toHaveLength(0);
    await act(async () => row('Back to Settings').props.onPress());
    expect(texts(r)).not.toContain('Address');
    expect(texts(r)).toContain('Notifications');

    await act(async () => row('E.D.I.T.H').props.onPress());
    expect(back.count()).toBe(before + 1);
    let handled = false;
    await act(async () => {
      handled = back.press();
    });
    expect(handled).toBe(true);
    expect(texts(r)).not.toContain('Address');
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
    expect(texts(r)).toContain('Address');
    await act(async () => page.set(null)); // Settings opened by a link: the list
    expect(texts(r)).not.toContain('Address');
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

  it('keeps every setting of the old list reachable, each page with its controls', async () => {
    const meter = { start: () => {}, stop: async () => null } as unknown as FrameMeter;
    const { r, loaded, page } = await mount(meter);
    // Every page the old list had, and what must still be on it (pages whose port is absent in tests,
    // Push and Live Alerts, are covered by their own tests).
    const pages: Record<string, string[]> = {
      'Server connection': ['Address', 'Change server'],
      'Claude accounts': ['Refresh', 'Add account'],
      Push: [],
      'Live Alerts': [],
      'Voice input': [],
      'Wake word': ['Sensitivity', 'Train wake word', '“Hey Edith”'],
      Appearance: [],
      Chat: ['Work details', 'Summary', 'Steps', 'Full'],
      Updates: ['Check for updates', 'Version'],
      Developer: ['Measure frames'],
    };
    for (const [title, controls] of Object.entries(pages)) {
      const opener = r.root.findAll((n) => n.props.accessibilityHint === `Opens ${title}` && typeof n.props.onPress === 'function')[0];
      expect([title, !!opener]).toEqual([title, true]);
      await act(async () => opener!.props.onPress());
      expect(page.get()).toBe(title);
      expect(r.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header' && n.props.children === title)).toHaveLength(1);
      for (const c of controls) expect([title, texts(r).includes(c)]).toEqual([title, true]);
      await act(async () => page.set(null));
    }
    act(() => r.unmount());
    loaded.cleanup();
  });

  it('puts a switch in a row whose setting is on or off: it switches in place, the row still opens the page', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    fakeBack();
    const ctx = fakeContext();
    const on = createStore(false);
    const sets: boolean[] = [];
    function useThingToggle() {
      const value = useStore(on, (v) => v);
      return { on: value, set: (v: boolean) => (sets.push(v), on.set(v)), detail: value ? 'Every 15 min' : null };
    }
    const sections = [
      { title: 'Thing', component: () => <Text>thing page</Text>, group: 'notifications' as const, toggle: useThingToggle, summary: () => 'On or off' },
      { title: 'Other', component: () => <Text>other page</Text>, group: 'notifications' as const, toggle: () => null, summary: () => 'No switch here', badge: () => 'Interseqt active' },
    ];
    const page = createStore<string | null>(null);
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<SettingsScreen connection={ctx.connection} sections={sections} meter={null} open={page} />);
    });
    // A section's badge joins the top card's line (its hook runs in a component of its own).
    const card = r.root.find((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityHint === 'Opens Server connection' && typeof n.props.onPress === 'function');
    expect(card.props.accessibilityLabel).toMatch(/^E\.D\.I\.T\.H, .+ · Interseqt active$/);
    const toggle = () => r.root.find((n) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === 'Thing' && typeof n.props.onPress === 'function');
    expect(toggle().props.accessibilityState).toMatchObject({ checked: false });
    expect(texts(r)).not.toContain('On or off'); // the switch says it
    await act(async () => toggle().props.onPress());
    expect(sets).toEqual([true]);
    expect(toggle().props.accessibilityState).toMatchObject({ checked: true });
    expect(texts(r)).toContain('Every 15 min');
    expect(page.get()).toBeNull(); // switching doesn't open the page
    // A section without a switch right now is a plain row with its line.
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === 'Other')).toHaveLength(0);
    expect(texts(r)).toContain('No switch here');
    const opener = r.root.find((n) => n.props.accessibilityHint === 'Opens Thing' && typeof n.props.onPress === 'function');
    await act(async () => opener.props.onPress());
    expect(texts(r)).toContain('thing page');
    act(() => r.unmount());
  });

  it('asks before Change server (the list’s bottom pill), then forgets the server', async () => {
    const { ctx, r, loaded, row } = await mount();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const forget = jest.spyOn(ctx.connection, 'forget').mockImplementation(async () => {});
    await act(async () => row('Change server').props.onPress());
    expect(alert.mock.calls[0]![0]).toBe('Change server?');
    expect(forget).not.toHaveBeenCalled();
    const buttons = alert.mock.calls[0]![2]!;
    await act(async () => buttons.find((b) => b.text === 'Disconnect')!.onPress!());
    expect(forget).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
    loaded.cleanup();
  });
});
