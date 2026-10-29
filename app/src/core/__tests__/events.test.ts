import { EventBus, localEvent } from '../events';
import { buttonRows, num, str } from '../guards';
import { ev } from '../../testing/fakes';

describe('EventBus', () => {
  it('matches globs and isolates failing handlers', () => {
    const bus = new EventBus();
    const got: string[] = [];
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    bus.subscribe('turn.*', (e) => got.push(`glob:${e.type}`));
    bus.subscribe('turn.done', () => {
      throw new Error('boom');
    });
    bus.on('turn.done', (e) => got.push(`typed:${e.data.ref}`));
    bus.publish(ev('turn.done', { ref: 'r1' }));
    bus.publish(ev('message.user', { text: 'x' }));
    expect(got).toEqual(['glob:turn.done', 'typed:r1']);
  });

  it('unsubscribes, even during a publish', () => {
    const bus = new EventBus();
    const got: string[] = [];
    const offB = bus.subscribe('*', () => got.push('b'));
    bus.subscribe('*', () => {
      got.push('a');
      offB();
    });
    bus.publish(localEvent('app.connected', { first: true }));
    bus.publish(localEvent('app.connected', { first: false }));
    expect(got).toEqual(['b', 'a', 'a']);
  });
});

describe('guards', () => {
  it('reads untrusted values', () => {
    expect(str(5)).toBe('5');
    expect(str(null, '-')).toBe('-');
    expect(num('5')).toBe(0);
    expect(num(Infinity, 1)).toBe(1);
  });

  it('keeps only well-formed buttons', () => {
    expect(
      buttonRows([[{ label: 'A', action: 'x:1' }, { label: 'B' }, null], 'junk', [], [{ label: 'C', action: 'y' }]]),
    ).toEqual([[{ label: 'A', action: 'x:1' }], [{ label: 'C', action: 'y' }]]);
    expect(buttonRows(undefined)).toEqual([]);
  });
});
