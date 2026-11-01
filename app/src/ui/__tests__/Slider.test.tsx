// The slider reports moves while dragged and commits once on release; taken away mid-drag (its page
// closed, its tool switched), it still commits the value reached instead of leaving it a draft.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { View } from 'react-native';

import { Slider } from '../Slider';

jest.setTimeout(30_000); // the first run transforms React Native

function mount(onChange: jest.Mock, onMove: jest.Mock) {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<Slider value={0.5} label="Glass" onChange={onChange} onMove={onMove} />);
  });
  const box = r.root.findAll((n) => n.type === View && typeof n.props.onResponderGrant === 'function')[0]!;
  act(() => box.props.onLayout({ nativeEvent: { layout: { width: 228, height: 40 } } }));
  const touch = (x: number) => ({ nativeEvent: { locationX: x, pageX: x, pageY: 0, touches: [], changedTouches: [], identifier: 1, timestamp: Date.now() }, touchHistory: { touchBank: [{ touchActive: true, startPageX: x, startPageY: 0, startTimeStamp: 0, currentPageX: x, currentPageY: 0, currentTimeStamp: 0, previousPageX: x, previousPageY: 0, previousTimeStamp: 0 }], numberActiveTouches: 1, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: 0 } });
  return { r, box, touch };
}

it('a drag cut short by unmounting still commits the value it reached', () => {
  const onChange = jest.fn();
  const onMove = jest.fn();
  const { r, box, touch } = mount(onChange, onMove);
  act(() => box.props.onResponderGrant(touch(114)));
  expect(onMove).toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled(); // mid-drag: only the preview follows
  const reached = onMove.mock.calls.at(-1)![0] as number;
  act(() => r.unmount());
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith(reached);
});

it('without a drag in progress, unmounting commits nothing', () => {
  const onChange = jest.fn();
  const { r } = mount(onChange, jest.fn());
  act(() => r.unmount());
  expect(onChange).not.toHaveBeenCalled();
});
