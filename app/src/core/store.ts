// A tiny external store plus a selector hook. Components re-render only when their selected
// value changes (by `isEqual`), not on every state change.

import { useRef, useSyncExternalStore } from 'react';

export interface Store<S> {
  get(): S;
  set(next: S | ((prev: S) => S)): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (prev: S) => S)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const l of [...listeners]) l();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Memoizes `select` on the state object it was given: the selector runs once per state change,
 * and a result equal to the previous one (by `isEqual`) keeps the previous reference.
 */
export function createSelector<S, T>(select: (s: S) => T, isEqual: (a: T, b: T) => boolean = Object.is): (s: S) => T {
  let last: { state: S; value: T } | null = null;
  return (state) => {
    if (last && last.state === state) return last.value;
    const value = select(state);
    last = { state, value: last && isEqual(last.value, value) ? last.value : value };
    return last.value;
  };
}

/**
 * Subscribe a component to a slice of a store. The selector runs only when the state (or the
 * selector) changes, and an equal result keeps the previous reference, so memoized children and
 * useSyncExternalStore both see "no change". Prefer selectors defined at module level.
 */
export function useStore<S, T>(store: Store<S>, select: (s: S) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ state: S; select: (s: S) => T; value: T } | null>(null);
  const getSnapshot = (): T => {
    const state = store.get();
    const prev = last.current;
    if (prev && prev.state === state && prev.select === select) return prev.value;
    const value = select(state);
    last.current = { state, select, value: prev && isEqual(prev.value, value) ? prev.value : value };
    return last.current.value;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

/** Shallow equality for arrays and plain objects (one level). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
