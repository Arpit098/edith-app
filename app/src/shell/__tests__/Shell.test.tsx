// Smoke test: the real features render inside the shell over a fake transport, and the main
// flows (connect gate, live events, approvals banner, tools grid, back button) work end to end.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { localEvent } from '../../core/events';
import { loadFeatures } from '../../core/feature';
import { features } from '../../features';
import { ev, fakeContext, flush } from '../../testing/fakes';
import { Squish } from '../../ui/motion';
import { Shell } from '../Shell';

jest.mock('../../ui/toast', () => ({ toast: jest.fn() }));
jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

const METRICS = { frame: { x: 0, y: 0, width: 400, height: 800 }, insets: { top: 24, left: 0, right: 0, bottom: 16 } };

function texts(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).filter((c) => typeof c === 'string' || typeof c === 'number').join(''))
    .join(' | ');
}

async function mount() {
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
        <Shell loaded={loaded} connection={ctx.connection} meter={null} />
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
    expect(t).toContain('Live');
    expect(t).toContain('Idle');
    expect(t).toContain('from history');
    expect(t).not.toContain('Sessions'); // no tab bar: the other screens are in the menu
    expect(r.root.findAll((n) => n.props.accessibilityLabel === 'Menu' && typeof n.props.onPress === 'function')).not.toHaveLength(0);

    await act(async () => {
      ctx.transport.emit(ev('message.user', { text: 'check the disk' }, { origin: 'telegram' }));
      ctx.transport.emit(ev('tool.call', { id: 'toolu_1', name: 'Bash', summary: '$ df -h' }));
      ctx.transport.emit(ev('permission.request', { id: 'ab', tool: 'Bash', detail: 'rm -rf /tmp/x', ref: null, lane: 'main' }));
    });
    expect(texts(r)).toContain('check the disk');
    expect(texts(r)).toContain('$ df -h');
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

  describe('navigation menu (top right)', () => {
    async function connected() {
      const m = await mount();
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
  });
});
