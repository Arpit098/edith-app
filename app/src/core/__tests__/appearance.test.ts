// The appearance store: read at start (garbled or missing gives the defaults), each change shown at
// once and written once the changes pause, a change made before the read wins, nothing lost on exit.

import { APPEARANCE_KEY, createAppearanceStore } from '../appearance';
import { DEFAULT_APPEARANCE } from '../theme';
import { MemoryStorage } from '../../testing/fakes';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('appearance store', () => {
  it('loads what was saved, made valid', async () => {
    const data = new MemoryStorage();
    data.data.set(APPEARANCE_KEY, JSON.stringify({ theme: 'ocean', myBubble: 'teal', glass: 25, background: 'nope' }));
    const s = createAppearanceStore(data);
    await s.load();
    expect(s.store.get()).toEqual({ ...DEFAULT_APPEARANCE, theme: 'ocean', myBubble: 'teal', glass: 25 });
  });

  it('keeps the defaults for nothing saved, garbage, or no storage at all', async () => {
    const data = new MemoryStorage();
    const s = createAppearanceStore(data);
    await s.load();
    expect(s.store.get()).toEqual(DEFAULT_APPEARANCE);
    data.data.set(APPEARANCE_KEY, '{not json');
    await s.load();
    expect(s.store.get()).toEqual(DEFAULT_APPEARANCE);
    const none = createAppearanceStore(undefined);
    await none.load();
    none.set({ theme: 'rose' });
    expect(none.store.get().theme).toBe('rose');
  });

  it('shows each change at once and saves once the changes pause', async () => {
    const data = new MemoryStorage();
    const writes = jest.spyOn(data, 'set');
    const s = createAppearanceStore(data);
    for (const glass of [10, 20, 30, 40]) s.set({ glass });
    expect(s.store.get().glass).toBe(40);
    expect(writes).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(500);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(data.data.get(APPEARANCE_KEY)!)).toMatchObject({ glass: 40 });
  });

  it('a change made before the saved one is read wins', async () => {
    const data = new MemoryStorage();
    data.data.set(APPEARANCE_KEY, JSON.stringify({ theme: 'ocean' }));
    const s = createAppearanceStore(data);
    s.set({ theme: 'forest' });
    await s.load();
    expect(s.store.get().theme).toBe('forest');
  });

  it('writes a pending change on dispose', () => {
    const data = new MemoryStorage();
    const s = createAppearanceStore(data);
    s.set({ background: 'dots' });
    s.dispose();
    expect(JSON.parse(data.data.get(APPEARANCE_KEY)!)).toMatchObject({ background: 'dots' });
  });

  it('flush writes a pending change at once (the app going to the background), and only once', async () => {
    const data = new MemoryStorage();
    const writes = jest.spyOn(data, 'set');
    const s = createAppearanceStore(data);
    s.flush(); // nothing pending: nothing written
    expect(writes).not.toHaveBeenCalled();
    s.set({ glass: 35 });
    s.flush();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(JSON.parse(data.data.get(APPEARANCE_KEY)!)).toMatchObject({ glass: 35 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveBeenCalledTimes(1); // the timer it replaced doesn't write again
  });
});
