// The chosen appearance (Settings → Appearance): kept on the phone (the data store) and applied at
// once, with no restart. Loaded at start; until it's read the app shows the defaults (Midnight, 60%
// glass), which is a few milliseconds. A drag on the glass slider changes it many times a second:
// each change shows at once, but it's written once the dragging pauses (SAVE_MS), or at once when
// the app goes to the background (flush), where Android may kill it before the timer fires.

import type { KeyValueStore } from './ports';
import { createStore, type Store } from './store';
import { DEFAULT_APPEARANCE, normalizeAppearance, type Appearance } from './theme/themes';

export const APPEARANCE_KEY = 'appearance.v1';
const SAVE_MS = 400;

export interface AppearanceStore {
  store: Store<Appearance>;
  /** Read the saved appearance (a broken or missing one gives the defaults). */
  load(): Promise<void>;
  set(change: Partial<Appearance>): void;
  /** Write a pending change now (the app is going to the background, where it may be killed). */
  flush(): void;
  dispose(): void;
}

export function createAppearanceStore(data: KeyValueStore | undefined): AppearanceStore {
  const store = createStore<Appearance>(DEFAULT_APPEARANCE);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let changed = false; // a change made before the saved one was read wins over it

  const save = () => {
    timer = null;
    void data?.set(APPEARANCE_KEY, JSON.stringify(store.get())).catch((e: unknown) => console.warn('[edith] appearance not saved', e));
  };
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      save(); // don't lose the last change
    }
  };

  return {
    store,
    async load() {
      let raw: string | null = null;
      try {
        raw = data ? await data.get(APPEARANCE_KEY) : null;
      } catch (e) {
        console.warn('[edith] appearance not read', e);
      }
      if (raw === null || changed) return;
      try {
        store.set(normalizeAppearance(JSON.parse(raw)));
      } catch {
        // garbled: keep the defaults; the next change overwrites it
      }
    },
    set(change) {
      changed = true;
      store.set((a) => normalizeAppearance({ ...a, ...change }));
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, SAVE_MS);
    },
    flush,
    dispose: flush,
  };
}
