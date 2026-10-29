import { createSelector, createStore, shallowEqual } from '../store';

describe('createStore', () => {
  it('notifies only on a real change', () => {
    const store = createStore({ n: 1 });
    const seen: number[] = [];
    const off = store.subscribe(() => seen.push(store.get().n));
    store.set((s) => ({ n: s.n + 1 }));
    store.set((s) => s); // same object: no notification
    off();
    store.set({ n: 9 });
    expect(seen).toEqual([2]);
  });
});

describe('createSelector', () => {
  it('runs once per state and keeps equal results', () => {
    const select = jest.fn((s: { items: number[]; other: number }) => s.items.filter((x) => x > 1));
    const selector = createSelector(select, shallowEqual);
    const s1 = { items: [1, 2, 3], other: 0 };
    const a = selector(s1);
    expect(selector(s1)).toBe(a);
    expect(select).toHaveBeenCalledTimes(1);
    const b = selector({ ...s1, other: 1 }); // new state, same filtered values
    expect(b).not.toBe(undefined);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('keeps the previous reference when the result is shallow-equal', () => {
    const selector = createSelector((s: { a: number; b: number }) => ({ a: s.a }), shallowEqual);
    const first = selector({ a: 1, b: 1 });
    expect(selector({ a: 1, b: 2 })).toBe(first);
    expect(selector({ a: 2, b: 2 })).not.toBe(first);
  });
});

describe('shallowEqual', () => {
  it('compares one level', () => {
    expect(shallowEqual([1, 2], [1, 2])).toBe(true);
    expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(shallowEqual({ a: { x: 1 } }, { a: { x: 1 } })).toBe(false);
  });
});
