// Chat bubbles keep their whole text: a short slash command ("/compact") once showed as just "/" on
// Arpit's phone (Android wrapped it after the slash and the one-line bubble clipped the rest).

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { clockIST } from '../../../common/format';
import type { Origin } from '../../../core/events';
import { ev, FakeTransport } from '../../../testing/fakes';
import { ItemView } from '../ItemView';
import { initialLive, reduce } from '../model';
import { createReceivedModel } from '../received';
import { ReceivedContext } from '../ReceivedFiles';

jest.setTimeout(30_000); // the first run transforms React Native

function render(type: 'message.user' | 'message.assistant', text: string, origin: Origin) {
  const item = [ev(type, { text, cursor: 's1:1' }, { origin })].reduce(reduce, initialLive).items[0]!;
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<ItemView item={item} onPress={async () => null} />);
  });
  return r;
}

describe('ItemView', () => {
  beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {})); // react-test-renderer is deprecated in React 19

  it.each([
    ['message.user', '/compact', 'app'],
    ['message.user', '/compact keep the plan', 'terminal'],
    ['message.user', '/status', 'telegram'],
    ['message.assistant', '/compact done', 'system'],
  ] as const)('shows %s "%s" whole, measured as Android draws it', (type, text, origin) => {
    const r = render(type, text, origin);
    const body = r.root.findAllByType(Text).filter((t) => t.props.children === text);
    expect(body).toHaveLength(1);
    expect(body[0]!.props.textBreakStrategy).toBe('simple');
    expect(body[0]!.props.numberOfLines).toBeUndefined();
    act(() => r.unmount());
  });

  it("shows the IST time on EDITH's replies, like on Arpit's messages", () => {
    const r = render('message.assistant', 'Done.', 'system');
    const item = [ev('message.assistant', { text: 'Done.', cursor: 's1:1' }, { origin: 'system' })].reduce(reduce, initialLive).items[0]!;
    const time = r.root.findAllByType(Text).filter((t) => t.props.children === clockIST(item.ts));
    expect(time).toHaveLength(1);
    act(() => r.unmount());
  });

  it("shows the files EDITH sent as chips: name and size, and a refused one as not available", () => {
    const data = {
      text: 'Here.',
      cursor: 's1:1',
      files: ['/a', '/b'],
      sent_files: [
        { id: 'c'.repeat(32), name: 'Plan v2.pdf', size: 2048, mime: 'application/pdf' },
        { name: 'id_rsa', error: 'in a private folder' },
      ],
    };
    const item = [ev('message.assistant', data)].reduce(reduce, initialLive).items[0]!;
    let r!: ReactTestRenderer;
    act(() => {
      r = create(
        <ReceivedContext.Provider value={createReceivedModel({ transport: new FakeTransport() })}>
          <ItemView item={item} onPress={async () => null} />
        </ReceivedContext.Provider>,
      );
    });
    const chips = r.root.findAll((n) => n.props.testID === 'sent-file' && typeof n.type !== 'string' && !!n.props.accessibilityLabel && n.props.onPress);
    const labels = [...new Set(chips.map((c) => c.props.accessibilityLabel as string))];
    expect(labels).toEqual(['Plan v2.pdf, 2 KB', 'id_rsa, not available: in a private folder']);
    const shown = r.root.findAllByType(Text).map((t) => t.props.children);
    expect(shown).toEqual(expect.arrayContaining(['Plan v2.pdf', '2 KB', 'id_rsa', 'Not available']));
    act(() => r.unmount());
  });
});
