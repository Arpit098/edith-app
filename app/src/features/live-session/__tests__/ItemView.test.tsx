// Chat bubbles keep their whole text: a short slash command ("/compact") once showed as just "/" on
// Arpit's phone (Android wrapped it after the slash and the one-line bubble clipped the rest).

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Text } from 'react-native';

import { clockIST } from '../../../common/format';
import type { Origin } from '../../../core/events';
import { ev } from '../../../testing/fakes';
import { ItemView } from '../ItemView';
import { initialLive, reduce } from '../model';

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
});
