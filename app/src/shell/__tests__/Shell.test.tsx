// Smoke test: the real features render inside the shell over a fake transport, and the main
// flows (connect gate, live events, approvals banner, tools grid, back button) work end to end.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler, Linking, StyleSheet, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { localEvent } from '../../core/events';
import type { LaunchLinks } from '../../core/ports';
import { loadFeatures } from '../../core/feature';
import { features } from '../../features';
import { ev, fakeContext, flush } from '../../testing/fakes';
import { Squish } from '../../ui/motion';
import { Shell } from '../Shell';

jest.mock('../../ui/toast', () => ({ toast: jest.fn() }));
// expo-font: not loaded until a test says so (mockFont.finish), then every useFonts re-renders as loaded.
const mockFont = { loaded: false, listeners: new Set<() => void>(), sources: [] as Record<string, unknown>[] };
jest.mock('expo-font', () => {
  const { useSyncExternalStore } = require('react');
  return {
    ...jest.requireActual('expo-font'), // the icon font (vector-icons) uses the rest
    useFonts: (sources: Record<string, unknown>) => {
      mockFont.sources.push(sources);
      const loaded = useSyncExternalStore(
        (on: () => void) => (mockFont.listeners.add(on), () => mockFont.listeners.delete(on)),
        () => mockFont.loaded,
      );
      return [loaded, null];
    },
  };
});
beforeEach(() => {
  mockFont.loaded = false;
  mockFont.sources = [];
});
const finishFontLoad = () => {
  mockFont.loaded = true;
  mockFont.listeners.forEach((on) => on());
};
jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

const METRICS = { frame: { x: 0, y: 0, width: 400, height: 800 }, insets: { top: 24, left: 0, right: 0, bottom: 16 } };

function texts(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).filter((c) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

async function mount(links: LaunchLinks | null = null) {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  const ctx = fakeContext();
  ctx.transport
    .on('GET /v1/status', { main: 'idle', queued: 0, runs: [], tmux: 'running', conversation: true, session: { id: 's1', title: 'disk check' } })
    .on('GET /v1/permissions', { pending: [] })
    .on('GET /v1/sessions/current/history?limit=100', {
      session_id: 's1',
      events: [{ type: 'message.assistant', ts: 1, session_id: 's1', origin: 'system', data: { text: 'from history', cursor: 's1:5' } }],
      start: 's1:0',
      cursor: 's1:5',
      more: false,
      reset: false,
    })
    .on('GET /v1/sessions', { sessions: [{ session_id: 's1', title: 'disk check', updated: 1_800_000_000, current: true }] })
    .on('GET /v1/commands', { commands: [{ name: 'today', description: 'Today', usage: '', help: 'x' }] });
  const loaded = loadFeatures(features, ctx);
  expect(loaded.failed).toEqual({});
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <Shell loaded={loaded} connection={ctx.connection} meter={null} links={links} />
      </SafeAreaProvider>,
    );
  });
  return { ctx, r, loaded };
}

describe('Shell', () => {
  it('asks for the server first, then shows the live view', async () => {
    const { ctx, r, loaded } = await mount();
    await act(() => ctx.connection.load());
    expect(texts(r)).toContain('Connect to EDITH');

    await act(() => ctx.connection.connect('edith', 'x'.repeat(40)));
    await act(async () => {
      ctx.transport.status({ state: 'open' });
      await flush();
    });
    const t = texts(r);
    // The home screen's title (plans/ui-next.md §2): off-white text with the soft blue glow.
    expect(r.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header' && n.props.children === 'E.D.I.T.H')).not.toHaveLength(0);
    // The status chip on the left: connection and EDITH's state, in its label.
    expect(r.root.findAll((n) => n.props?.accessibilityLabel === 'Connected. EDITH: Idle. Show details' && typeof n.props.onPress === 'function')).not.toHaveLength(0);
    expect(t).toContain('from history');
    expect(t).not.toContain('Sessions'); // no tab bar: the other screens are in the menu
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Menu' && typeof n.props.onPress === 'function')).not.toHaveLength(0);

    await act(async () => {
      ctx.transport.emit(ev('message.user', { text: 'check the disk' }, { origin: 'telegram' }));
      ctx.transport.emit(ev('turn.started', { ref: 'r1', lane: 'main' }));
      ctx.transport.emit(ev('tool.call',{ id: 'toolu_1', name: 'Bash', summary: '$ df -h' }));
      ctx.transport.emit(ev('permission.request', { id: 'ab', tool: 'Bash', detail: 'rm -rf /tmp/x', ref: null, lane: 'main' }));
    });
    expect(texts(r)).toContain('check the disk');
    // The running tool is the Work card's live step, in plain words: no "$" prefix.
    expect(texts(r)).toContain('df -h…');
    expect(texts(r)).not.toContain('$ df -h');
    // No "Running …" line above the composer repeating it; the chip still says so to TalkBack.
    expect(texts(r)).not.toContain('Running');
    expect(r.root.findAll((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.includes('EDITH: Waiting for approval'))).not.toHaveLength(0);
    // ...and announces each change of state (the removed row was the chat's live region).
    const live = r.root.findAll((n) => n.type === Text && n.props.testID === 'status-live-region')[0]!;
    expect(live.props.accessibilityLiveRegion).toBe('polite');
    expect(live.props.children).toBe('EDITH: Waiting for approval');
    expect(texts(r)).toContain('Approve Bash?');

    await act(async () => {
      ctx.transport.emit(ev('permission.resolved', { id: 'ab', decision: 'gone' }));
    });
    expect(texts(r)).not.toContain('Approve Bash?');
    act(() => r.unmount());
    loaded.cleanup();
  });

  it('opens a tool from the grid and goes back with the Android back button', async () => {
    const { ctx, r, loaded } = await mount();
    const back = jest.spyOn(BackHandler, 'addEventListener');
    await act(() => ctx.connection.connect('edith', 'x'.repeat(40)));
    await act(async () => ctx.transport.status({ state: 'open' }));

    const press = async (label: string) => {
      const target = r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
      if (!target) throw new Error(`no ${label}`);
      await act(async () => {
        target.props.onPress();
        await flush();
      });
    };
    const shellBack = back.mock.calls.at(-1)![1] as () => boolean; // registered before the menu's
    await press('Menu');
    await press('Tools');
    await press('Commands');
    expect(texts(r)).toContain('/today');

    // The title never runs under the back arrow and chip (Arpit's screenshot at 360 dp: the chip
    // covered "Co"): with no room to centre it, it starts after the chip and is cut with "…".
    const byId = (id: string) => r.root.findAll((n) => n.props.testID === id && typeof n.props.onLayout === 'function')[0]!;
    const layout = async (id: string, l: { x: number; width: number }) => act(async () => byId(id).props.onLayout({ nativeEvent: { layout: { y: 0, height: 56, ...l } } }));
    const title = () => StyleSheet.flatten(r.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header' && n.props.children === 'Commands')[0]!.props.style);
    expect(title().opacity).toBe(0); // not placed until measured
    await layout('header-row', { x: 0, width: 360 });
    await layout('header-free', { x: 180, width: 116 });
    await layout('header-title-measure', { x: 0, width: 130 });
    expect(title()).toMatchObject({ left: 180, right: 64, textAlign: 'left' });
    expect(title().opacity).toBeUndefined();
    // Room to centre it (no timer in the chip): centred on the row.
    await layout('header-free', { x: 100, width: 196 });
    expect(title()).toMatchObject({ left: 100, right: 100, textAlign: 'center' });
    // Another page: its title stays hidden until its own width is measured (not the last one's).
    await press('Menu');
    await press('Sessions');
    const sessions = () => StyleSheet.flatten(r.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header' && n.props.children === 'Sessions')[0]!.props.style);
    expect(sessions().opacity).toBe(0);
    await layout('header-title-measure', { x: 0, width: 120 });
    expect(sessions()).toMatchObject({ left: 100, right: 100, textAlign: 'center' });
    await press('Menu');
    await press('Tools');
    await press('Commands');

    const handler = shellBack;
    let handled = false;
    await act(async () => {
      handled = handler();
    });
    expect(handled).toBe(true);
    expect(texts(r)).not.toContain('/today');
    act(() => r.unmount());
    loaded.cleanup();
  });

  it('draws E.D.I.T.H in Michroma once it loads, on the system font until then; other titles never', async () => {
    const { ctx, r, loaded } = await mount();
    await act(() => ctx.connection.connect('edith', 'x'.repeat(40)));
    await act(async () => ctx.transport.status({ state: 'open' }));
    expect(Object.keys(mockFont.sources[0]!)).toEqual(['Michroma']); // asked for at startup, as a bundled asset
    const header = (name: string) => r.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header' && n.props.children === name)[0]!;
    const measure = () => r.root.findAll((n) => n.type === Text && n.props.testID === 'header-title-measure')[0]!;
    const font = (n: { props: Record<string, unknown> }) => StyleSheet.flatten(n.props.style as never) as { fontFamily?: string; fontSize?: number; fontWeight?: string; textShadowColor?: string; color?: string };

    // Not loaded yet (or failed): the app runs as before, the system font.
    expect(font(header('E.D.I.T.H')).fontFamily).toBeUndefined();
    expect(header('E.D.I.T.H').props.maxFontSizeMultiplier).toBeUndefined();
    const before = font(header('E.D.I.T.H'));

    await act(async () => finishFontLoad());
    const title = font(header('E.D.I.T.H'));
    expect(title).toMatchObject({ fontFamily: 'Michroma', fontSize: 18, fontWeight: '400', color: before.color, textShadowColor: before.textShadowColor });
    expect(header('E.D.I.T.H').props.maxFontSizeMultiplier).toBe(1.3);
    // The hidden measuring copy uses the same font, so the header layout (headerTitle.ts) sees its real width.
    expect(font(measure())).toMatchObject({ fontFamily: 'Michroma', fontSize: 18 });
    expect(measure().props.maxFontSizeMultiplier).toBe(1.3);

    // A sub-page's title (same style object) stays on the system font.
    const press = async (label: string) => {
      const target = r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0]!;
      await act(async () => {
        target.props.onPress();
        await flush();
      });
    };
    await press('Menu');
    await press('Tools');
    expect(font(header('Tools')).fontFamily).toBeUndefined();
    expect(font(header('Tools')).fontSize).toBe(before.fontSize);
    expect(font(measure()).fontFamily).toBeUndefined();
    act(() => r.unmount());
    loaded.cleanup();
  });

  describe('navigation menu (top right)', () => {
    async function connected(links: LaunchLinks | null = null, seenLinks?: unknown[]) {
      const m = await mount(links);
      if (seenLinks) m.ctx.bus.on('app.link', (e) => void seenLinks.push(e.data), 'test');
      let screen = '';
      m.ctx.bus.on('app.screen', (e) => void (screen = String(e.data.name)), 'test'); // what the shell shows
      await act(() => m.ctx.connection.connect('edith', 'x'.repeat(40)));
      await act(async () => m.ctx.transport.status({ state: 'open' }));
      const find = (label: string) => m.r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
      const press = async (label: string) => {
        const target = find(label);
        if (!target) throw new Error(`no ${label}`);
        await act(async () => {
          target.props.onPress();
          await flush();
        });
      };
      // Squish is memo(): a test instance's type is the function inside it.
      const squish = (Squish as unknown as { type: unknown }).type;
      const items = () => m.r.root.findAll((n) => n.type === squish && n.props.accessibilityRole === 'menuitem');
      const title = () => screen;
      return { ...m, find, press, items, title };
    }

    it('lists the main screens with the current one marked, and goes where you pick', async () => {
      const { r, loaded, press, items, find, title } = await connected();
      expect(items()).toHaveLength(0); // closed: not even mounted
      await press('Menu');
      expect(items().map((n) => n.props.accessibilityLabel)).toEqual(['Live, current screen', 'Sessions', 'Tools', 'Settings']);
      expect(items()[0]!.props.accessibilityState).toEqual({ selected: true });
      expect(find('Close the menu')).toBeTruthy(); // the button says it closes now

      await press('Sessions');
      expect(title()).toBe('sessions');
      expect(items()).toHaveLength(0); // closed after picking

      await press('Menu');
      expect(items().find((n) => n.props.accessibilityState?.selected)?.props.accessibilityLabel).toBe('Sessions, current screen');
      act(() => r.unmount());
      loaded.cleanup();
    });

    it('closes on a tap outside and on Android back, without navigating', async () => {
      const { r, loaded, press, items, title } = await connected();
      const back = jest.spyOn(BackHandler, 'addEventListener');
      await press('Menu');
      const outside = r.root.findAll((n) => n.props.accessibilityLabel === 'Close the menu' && n.props.importantForAccessibility === 'no' && typeof n.props.onPress === 'function')[0]!;
      await act(async () => outside.props.onPress());
      expect(items()).toHaveLength(0);

      await press('Menu');
      const menuBack = back.mock.calls.at(-1)![1] as () => boolean;
      let handled = false;
      await act(async () => {
        handled = menuBack();
      });
      expect(handled).toBe(true);
      expect(items()).toHaveLength(0);
      expect(title()).toBe('live'); // still where it was
      act(() => r.unmount());
      loaded.cleanup();
    });

    it('a deep link (a tapped notification) still navigates, and closes an open menu', async () => {
      const { ctx, r, loaded, press, items, title } = await connected();
      await press('Menu');
      await act(async () => {
        ctx.bus.publish(localEvent('app.open', { screen: 'settings' }));
        await flush();
      });
      expect(title()).toBe('settings');
      expect(items()).toHaveLength(0);
      act(() => r.unmount());
      loaded.cleanup();
    });

    /** React Native's Linking 'url' events, captured (its own mock is a jest.fn: swapped by hand, as a spy would change it for the other tests). */
    function captureUrls() {
      const handlers: ((e: { url: string }) => void)[] = [];
      const original = Linking.addEventListener;
      Linking.addEventListener = ((_: string, h: (e: { url: string }) => void) => {
        handlers.push(h);
        return { remove: () => handlers.splice(handlers.indexOf(h), 1) };
      }) as never;
      return { send: (url: string) => handlers.forEach((h) => h({ url })), restore: () => (Linking.addEventListener = original) };
    }

    /** Like the native LaunchLinks: the launch link once, then cleared; trusted only with the install's key. */
    function fakeLinks(initial: string | null) {
      let pending = initial;
      const consumed: string[] = [];
      const links: LaunchLinks = {
        initial: () => {
          const url = pending;
          pending = null;
          return url;
        },
        consume: (url) => void consumed.push(url),
        trusted: (url) => url.includes('k=secret'),
      };
      return { links, consumed };
    }

    it("a widget's link opens the chat and hands it the action, trusted only with the key; Settings links don't", async () => {
      const urls = captureUrls();
      const { links, consumed } = fakeLinks(null);
      const { ctx, r, loaded, press, title } = await connected(links);
      const seen: unknown[] = [];
      ctx.bus.on('app.link', (e) => void seen.push(e.data), 'test');
      await press('Menu');
      await press('Settings');
      expect(title()).toBe('settings');
      await act(async () => {
        urls.send('edith://live/attach?k=secret');
        await flush();
      });
      expect(title()).toBe('live');
      await act(async () => {
        urls.send('edith://live/listen'); // any app or page can send this one
        urls.send('edith://settings/updates');
        urls.send('edith://live');
        await flush();
      });
      expect(seen).toEqual([
        { screen: 'live', action: 'attach', trusted: true },
        { screen: 'live', action: 'listen', trusted: false },
      ]); // a Settings page is the shell's own; a plain link has no action
      expect(consumed).toEqual(['edith://live/attach?k=secret', 'edith://live/listen', 'edith://settings/updates', 'edith://live']);
      urls.restore();
      act(() => r.unmount());
      loaded.cleanup();
    });

    it('runs the launch link once: a JS reload (or a restore from Recents) does not start the mic again', async () => {
      const urls = captureUrls();
      const { links } = fakeLinks('edith://live/listen?k=secret');
      const seen: unknown[] = [];
      const first = await connected(links, seen);
      expect(seen).toEqual([{ screen: 'live', action: 'listen', trusted: true }]);
      act(() => first.r.unmount());
      first.loaded.cleanup();
      // A reload mounts the app again on the same activity: the link must not come back.
      const again = await connected(links, seen);
      await act(async () => flush());
      expect(seen).toHaveLength(1);
      urls.restore();
      act(() => again.r.unmount());
      again.loaded.cleanup();
    });

    it('opens Settings from outside on the page asked for, else on the list, never a page left open', async () => {
      const { ctx, r, loaded, press, title } = await connected();
      await press('Menu');
      await press('Settings');
      const updates = r.root.findAll((n) => n.props.accessibilityHint === 'Opens Updates' && typeof n.props.onPress === 'function')[0]!;
      await act(async () => updates.props.onPress());
      const pageOpen = () => r.root.findAll((n) => n.type === Text && n.props.accessibilityRole === 'header' && n.props.children === 'Updates').length > 0;
      expect(pageOpen()).toBe(true);
      await act(async () => {
        ctx.bus.publish(localEvent('app.open', { screen: 'live' }));
        ctx.bus.publish(localEvent('app.open', { screen: 'settings' })); // e.g. a link: the list, not Updates
        await flush();
      });
      expect(title()).toBe('settings');
      expect(pageOpen()).toBe(false);
      expect(texts(r)).toContain('Notifications');

      // The token is rejected while another page is open: the status card's "Open Settings" (a feature,
      // through app.open with a page) lands on Server connection directly.
      await act(async () => updates.props.onPress());
      await act(async () => {
        ctx.bus.publish(localEvent('app.open', { screen: 'live' }));
        ctx.bus.publish(localEvent('app.open', { screen: 'settings', page: 'Server connection' }));
        await flush();
      });
      expect(title()).toBe('settings');
      expect(pageOpen()).toBe(false);
      expect(texts(r)).toContain('Address'); // the Server connection page (Change server is on the list too)
      act(() => r.unmount());
      loaded.cleanup();
    });
  });
});
