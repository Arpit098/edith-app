// A file chip on EDITH's bubble: a spinner while it downloads, the phone's viewer on a tap, Share and
// Save on a long press, and Share/Save offered when no app opens the type.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, type AlertButton } from 'react-native';

import type { ReceivedFiles } from '../../../core/ports';
import { FakeTransport, flush } from '../../../testing/fakes';
import { createReceivedModel, noViewerMessage, type SentFile } from '../received';
import { ReceivedContext, SentFileChips } from '../ReceivedFiles';

jest.setTimeout(30_000); // the first run transforms React Native

const PDF: SentFile = { id: 'a'.repeat(32), name: 'Plan v2.pdf', size: 2048, mime: 'application/pdf', error: null };

function setup(view: ReceivedFiles['view']) {
  let finish: (uri: string) => void = () => {};
  const cache = new Map<string, string>();
  const files: ReceivedFiles = {
    cached: ({ id }) => cache.get(id) ?? null,
    download: (_r, f) =>
      new Promise((resolve) => {
        finish = (uri) => {
          cache.set(f.id, uri);
          resolve(uri);
        };
      }),
    readText: async () => '',
    save: async () => 'EDITH',
    view,
    share: async () => {},
    prune: () => {},
  };
  const transport = new FakeTransport();
  transport.configure({ baseUrl: 'http://100.1.2.3:8787', token: 'tok' });
  const model = createReceivedModel({ transport, files });
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <ReceivedContext.Provider value={model}>
        <SentFileChips files={[PDF]} />
      </ReceivedContext.Provider>,
    );
  });
  const chip = () => r.root.find((n) => n.props.testID === 'sent-file' && typeof n.type !== 'string' && !!n.props.onPress);
  return { r, chip, finish: (uri: string) => finish(uri) };
}

const buttons = (spy: jest.SpyInstance) => ((spy.mock.calls.at(-1)?.[2] ?? []) as AlertButton[]).map((b) => b.text);

describe('SentFileChip', () => {
  it('shows a spinner while it downloads, then opens it in the viewer', async () => {
    const view = jest.fn(async () => 'opened' as const);
    const { r, chip, finish } = setup(view);
    await act(async () => {
      chip().props.onPress();
      await flush();
    });
    expect(r.root.findAll((n) => n.props.testID === 'sent-file-spinner').length).toBeGreaterThan(0);
    await act(async () => {
      finish('file:///cache/received/a/Plan v2.pdf');
      await flush();
    });
    expect(view).toHaveBeenCalledWith('file:///cache/received/a/Plan v2.pdf', 'application/pdf');
    expect(r.root.findAll((n) => n.props.testID === 'sent-file-spinner')).toHaveLength(0);
    act(() => r.unmount());
  });

  it('offers Share and Save when no app opens it, and on a long press', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const { r, chip, finish } = setup(async () => 'no-app');
    await act(async () => {
      chip().props.onPress();
      await flush();
      finish('file:///c/p.pdf');
      await flush();
    });
    expect(alert).toHaveBeenLastCalledWith('Plan v2.pdf', noViewerMessage('Plan v2.pdf'), expect.any(Array));
    expect(buttons(alert)).toEqual(['Cancel', 'Save to folder', 'Share']);
    act(() => chip().props.onLongPress());
    expect(alert).toHaveBeenLastCalledWith('Plan v2.pdf', undefined, expect.any(Array));
    expect(buttons(alert)).toEqual(['Cancel', 'Save to folder', 'Share']);
    alert.mockRestore();
    act(() => r.unmount());
  });
});
