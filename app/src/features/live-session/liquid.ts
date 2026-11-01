// Which chat bubbles are liquid glass (ui/Glass BubbleLens): decided by what's on screen, not by
// position in the list, and never changed while a bubble is in view and the list is still.
//
// - At most LIQUID_CAP at a time: each is a native glass view with its own compiled lens shader, and
//   edith-glass keeps 4 spare shaders for views that come and go. With no more than that, scrolling
//   reuses shaders and never compiles one on the UI thread.
// - While the list is still: a bubble scrolling or arriving into view gets glass if there's room
//   (the newest first); one leaving the view gives its glass up (it's off screen then). No bubble
//   in view switches.
// - While it moves, bubble glass is hidden anyway (LiveScreen fades it out: nothing re-blurs per
//   frame), so nothing is added; when it stops, the newest bubbles in view take the glass, hidden
//   until it fades back in.

import { createStore, type Store } from '../../core/store';
import type { Item } from './model';

export const LIQUID_CAP = 4;

/** A viewable row as FlatList reports it (ViewToken). */
export interface SeenRow {
  item: Item;
  index: number | null;
  isViewable: boolean;
}

const isBubble = (item: Item) => item.kind === 'user' || item.kind === 'assistant';
const EMPTY: ReadonlySet<number> = new Set();

const same = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a.size === b.size && [...a].every((x) => b.has(x));

export interface LiquidRows {
  store: Store<ReadonlySet<number>>;
  /** FlatList onViewableItemsChanged. */
  viewable(info: { viewableItems: SeenRow[]; changed: SeenRow[] }): void;
  /** The list started (true) or stopped (false) moving. */
  moving(on: boolean): void;
}

/** The newest bubbles of `rows` (lowest index: the list is newest first), at most `cap`. */
export function newestBubbles(rows: readonly SeenRow[], cap = LIQUID_CAP): ReadonlySet<number> {
  return new Set(
    rows
      .filter((r) => r.isViewable && isBubble(r.item))
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .slice(0, cap)
      .map((r) => r.item.id),
  );
}

/** At rest: leaving rows give their glass up, entering bubbles take free glass (newest first). */
export function settle(current: ReadonlySet<number>, changed: readonly SeenRow[], cap = LIQUID_CAP, adding = true): ReadonlySet<number> {
  const next = new Set(current);
  for (const r of changed) if (!r.isViewable) next.delete(r.item.id);
  if (adding) {
    const entering = changed.filter((r) => r.isViewable && isBubble(r.item) && !next.has(r.item.id)).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (const r of entering) {
      if (next.size >= cap) break;
      next.add(r.item.id);
    }
  }
  return same(next, current) ? current : next;
}

export function createLiquidRows(cap = LIQUID_CAP): LiquidRows {
  const store = createStore<ReadonlySet<number>>(EMPTY);
  let inView: SeenRow[] = [];
  let isMoving = false;
  return {
    store,
    viewable({ viewableItems, changed }) {
      inView = viewableItems;
      store.set((s) => settle(s, changed, cap, !isMoving));
    },
    moving(on) {
      if (on === isMoving) return;
      isMoving = on;
      if (!on) {
        const next = newestBubbles(inView, cap);
        store.set((s) => (same(s, next) ? s : next));
      }
    },
  };
}
