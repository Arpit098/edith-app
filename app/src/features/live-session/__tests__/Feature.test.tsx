// The live-session feature closes the composer's menu when another screen comes up, so it never
// stays open behind that screen (where its back handler would eat the next back press).

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler } from 'react-native';

import { localEvent } from '../../../core/events';
import { GlassContext } from '../../../core/theme';
import { fakeContext } from '../../../testing/fakes';
import liveSession from '../index';
import { MENU_LABEL } from '../ComposerMenu';

jest.setTimeout(30_000);
jest.mock('../../../ui/toast', () => ({ toast: jest.fn() }));

const menuItems = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.accessibilityRole === 'menuitem' && typeof n.props.onPress === 'function', { deep: false });

describe('live-session feature', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('closes the composer menu on app.screen for another screen, and keeps it for live', () => {
    let backHandlers = 0;
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation(() => {
      backHandlers++;
      return { remove: () => void backHandlers-- };
    });
    const ctx = fakeContext();
    const cleanup = liveSession.setup!(ctx) as () => void;
    const Screen = liveSession.screens![0]!.component;
    let r!: ReactTestRenderer;
    act(() => {
      r = create(
        <GlassContext.Provider value={{ mode: 'flat', View: null, reduceMotion: true }}>
          <Screen />
        </GlassContext.Provider>,
      );
    });
    const open = () => act(() => r.root.findAll((n) => n.props.accessibilityLabel === MENU_LABEL && typeof n.props.onPress === 'function', { deep: false })[0]!.props.onPress());

    open();
    expect(menuItems(r).length).toBeGreaterThan(0);
    act(() => ctx.bus.publish(localEvent('app.screen', { name: 'live' })));
    expect(menuItems(r).length).toBeGreaterThan(0);
    act(() => ctx.bus.publish(localEvent('app.screen', { name: 'sessions' })));
    expect(menuItems(r)).toHaveLength(0);
    expect(backHandlers).toBe(0);
    act(() => r.unmount());
    cleanup();
  });
});
