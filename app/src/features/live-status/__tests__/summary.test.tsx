// Settings → Live Alerts row: Android's switch is read once, then again only when EDITH comes back to
// the front (e.g. from that switch), never on every render.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { loadFeatures } from '../../../core/feature';
import type { AppVisibility, OngoingStatus } from '../../../core/ports';
import { fakeContext } from '../../../testing/fakes';
import liveStatus from '../index';

jest.setTimeout(30_000); // the first run transforms React Native

it('re-reads whether Live Updates are allowed on coming back to the front, not on each render', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let allowed = false;
  let reads = 0;
  const status = { liveUpdates: true, canPromote: () => (reads++, allowed), show() {}, clear() {} } as unknown as OngoingStatus;
  const handlers = new Set<(active: boolean) => void>();
  const visibility: AppVisibility = { active: () => true, onChange: (h) => (handlers.add(h), () => void handlers.delete(h)) };
  const ctx = fakeContext();
  const loaded = loadFeatures([liveStatus], { ...ctx, ports: { ...ctx.ports, status, visibility } });
  expect(loaded.failed).toEqual({});
  const useSummary = loaded.settings[0]!.summary!;
  function Row({ n }: { n: number }) {
    return <Text>{`${useSummary()} ${n}`}</Text>;
  }

  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<Row n={1} />);
  });
  const shown = () => String(r.root.findByType(Text).props.children);
  expect(shown()).toBe('Live Updates are off 1');
  await act(async () => r.update(<Row n={2} />));
  await act(async () => r.update(<Row n={3} />));
  expect(reads).toBe(1); // re-renders don't ask Android again

  allowed = true; // switched on in Android's settings
  await act(async () => handlers.forEach((h) => h(false))); // leaving: nothing to read
  expect(reads).toBe(1);
  await act(async () => handlers.forEach((h) => h(true)));
  expect(reads).toBe(2);
  expect(shown()).toBe('Shows in the pill 3');

  act(() => r.unmount());
  expect(handlers.size).toBe(0); // unsubscribed with the row
  loaded.cleanup();
});
