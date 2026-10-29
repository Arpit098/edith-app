// Smoke test: the real features render inside the shell over a fake transport, and the main
// flows (connect gate, live events, approvals banner, tools grid, back button) work end to end.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler, Text } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { loadFeatures } from '../../core/feature';
import { features } from '../../features';
import { ev, fakeContext, flush } from '../../testing/fakes';
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
    .on('GET /v1/sessions', { sessions: [{ session_id: 's1', title: 'disk check', updated: 1_800_000_000, current: true }] })
    .on('GET /v1/commands', { commands: [{ name: 'today', description: 'Today', usage: '', help: 'x' }] });
  const loaded = loadFeatures(features, ctx);
  expect(loaded.failed).toEqual({});
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(
      <SafeAreaProvider initialMetrics={METRICS}>
        <Shell loaded={loaded} connection={ctx.connection} />
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
    expect(t).toContain('Sessions');
    expect(t).toContain('Tools');
    expect(t).toContain('Settings');

    await act(async () => {
      ctx.transport.emit(ev('message.user', { text: 'check the disk' }, { origin: 'telegram' }));
      ctx.transport.emit(ev('tool.call', { name: 'Bash', summary: '$ df -h' }));
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
    process.stderr.write("C\n");     await act(() => ctx.connection.connect('edith', 'x'.repeat(40)));
    process.stderr.write("D\n");
    await act(async () => ctx.transport.status({ state: 'open' }));

    const press = async (label: string) => {
      const target = r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
      if (!target) throw new Error(`no ${label}`);
      await act(async () => {
        target.props.onPress();
        await flush();
      });
    };
    await press('Tools');
    await press('Commands');
    expect(texts(r)).toContain('/today');

    const handler = back.mock.calls.at(-1)![1] as () => boolean;
    let handled = false;
    await act(async () => {
      handled = handler();
    });
    expect(handled).toBe(true);
    expect(texts(r)).not.toContain('/today');
    act(() => r.unmount());
    loaded.cleanup();
  });
});
