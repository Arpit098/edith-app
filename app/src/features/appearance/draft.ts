// What Appearance shows but hasn't applied: a slider being dragged (glass, blur, dim, intensity) or a
// gradient being built. Only the preview and the open tool read it, so a drag repaints those, never
// the page around them or the app behind; the store (and the app) changes once, on release or Save.
// A drag reports every touch move, most of them the same rounded value: those are dropped here, so
// the preview (and a photo's blur, which decodes the image again) redraws only when it would change.

import { useMemo } from 'react';

import { createStore, useStore, type Store } from '../../core/store';
import { resolveTheme, useAppearance, useTheme, type Appearance, type Theme } from '../../core/theme';

export type Draft = Partial<Appearance> | null;

export interface DraftStore {
  store: Store<Draft>;
  /** Show `d` in the preview (null: nothing pending). The same value again changes nothing. */
  put(d: Draft): void;
}

export function createDraft(): DraftStore {
  const store = createStore<Draft>(null);
  let last = 'null';
  return {
    store,
    put(d) {
      const key = JSON.stringify(d); // a few small fields: cheap, and exact for nested ones (a photo's adjust)
      if (key === last) return;
      last = key;
      store.set(d);
    },
  };
}

const selectDraft = (d: Draft) => d;

/** The theme the preview draws: the app's, or the app's with the draft over it. */
export function usePreviewTheme(draft: DraftStore): Theme {
  const live = useTheme(); // knows "reduce transparency"
  const { appearance } = useAppearance();
  const d = useStore(draft.store, selectDraft);
  return useMemo(() => {
    if (d === null) return live;
    const reduced = live.glass === 0 && appearance.glass > 0;
    return resolveTheme({ ...appearance, ...d }, reduced);
  }, [d, live, appearance]);
}
