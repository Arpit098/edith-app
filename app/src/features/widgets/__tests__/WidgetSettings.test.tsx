import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import type { HomeWidgets } from '../../../core/ports';
import { fakeContext } from '../../../testing/fakes';
import { createWidgetsModel } from '../model';
import { widgetsSummary } from '../summary';
import { WidgetSettings } from '../WidgetSettings';

jest.setTimeout(30_000); // the first run transforms React Native

const texts = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).join(''))
    .join(' | ');

function fakeWidgets() {
  const calls: boolean[] = [];
  let show = true;
  const widgets: HomeWidgets = {
    read: () => null,
    write: () => {},
    showText: () => show,
    setShowText: (on) => {
      show = on;
      calls.push(on);
    },
  };
  return { widgets, calls };
}

describe('Settings → Widgets', () => {
  it('switches "Show message text in widgets" off and on, saved on the phone', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
    const ctx = fakeContext();
    const { widgets, calls } = fakeWidgets();
    const model = createWidgetsModel({ bus: ctx.bus, api: ctx.api, widgets });
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<WidgetSettings model={model} />);
    });
    expect(texts(r)).toContain('Message text shown');
    expect(texts(r)).toContain('On a lock screen it never shows the text');
    const row = () => r.root.findAll((n) => n.props.accessibilityRole === 'switch' && n.props.accessibilityLabel === 'Show message text in widgets' && typeof n.props.onPress === 'function')[0]!;
    expect(row().props.accessibilityState.checked).toBe(true);
    await act(async () => row().props.onPress());
    expect(calls).toEqual([false]);
    expect(row().props.accessibilityState.checked).toBe(false);
    expect(texts(r)).toContain('Message text hidden');
    await act(async () => row().props.onPress());
    expect(calls).toEqual([false, true]);
    act(() => r.unmount());
    model.dispose();
  });

  it('says so on a phone without the widgets', async () => {
    let r!: ReactTestRenderer;
    await act(async () => {
      r = create(<WidgetSettings model={null} />);
    });
    expect(texts(r)).toContain('Not available on this phone');
    act(() => r.unmount());
  });

  it('summarises the setting in a few words', () => {
    expect([widgetsSummary(true), widgetsSummary(false)]).toEqual(['Message text shown', 'Message text hidden']);
  });
});
