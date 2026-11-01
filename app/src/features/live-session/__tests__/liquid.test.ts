// Which bubbles are liquid glass: by what's in view, at most LIQUID_CAP (edith-glass's spare shader
// pool covers them, so none compiles while scrolling), the newest first; a bubble in view never
// switches while the list is still; while it moves nothing is added, and when it stops the newest
// bubbles in view take the glass.

import { createLiquidRows, LIQUID_CAP, newestBubbles, settle, type SeenRow } from '../liquid';
import type { Item } from '../model';

const bubble = (id: number): Item => ({ kind: id % 2 ? 'user' : 'assistant', id, ts: 0, text: `m${id}` }) as unknown as Item;
const tool = (id: number): Item => ({ kind: 'tool', id, ts: 0 }) as unknown as Item;
/** Row `id` at list index `index` (0 is the newest, at the bottom). */
const seen = (item: Item, index: number, isViewable = true): SeenRow => ({ item, index, isViewable });
const ids = (s: ReadonlySet<number>) => [...s].sort((a, b) => a - b);

describe('liquid rows', () => {
  it('in view at first: the newest bubbles, at most the cap; tool rows never', () => {
    const rows = [seen(tool(100), 0), ...[1, 2, 3, 4, 5, 6].map((id, i) => seen(bubble(id), i + 1))];
    expect(ids(newestBubbles(rows))).toEqual([1, 2, 3, 4]);
    expect(LIQUID_CAP).toBeLessThanOrEqual(4); // edith-glass keeps 4 spare lens shaders
    const l = createLiquidRows();
    l.viewable({ viewableItems: rows, changed: rows });
    expect(ids(l.store.get())).toEqual([1, 2, 3, 4]);
  });

  it('at rest a new message gets glass only if a slot frees: no bubble in view switches', () => {
    let s: ReadonlySet<number> = new Set([1, 2, 3, 4]);
    // A new message (7) arrives at the bottom; 4, at the top, scrolls out at the same time.
    s = settle(s, [seen(bubble(7), 0), seen(bubble(4), 5, false)]);
    expect(ids(s)).toEqual([1, 2, 3, 7]);
    // Another arrives with no room: it stays flat, and the glassy ones stay glass.
    s = settle(s, [seen(bubble(8), 0)]);
    expect(ids(s)).toEqual([1, 2, 3, 7]);
    const unchanged = settle(s, []);
    expect(unchanged).toBe(s); // same set: no row re-renders
  });

  it('while moving nothing is added (the glass is faded out anyway); when it stops, the newest in view take it', () => {
    const l = createLiquidRows();
    const first = [1, 2, 3, 4].map((id, i) => seen(bubble(id), i));
    l.viewable({ viewableItems: first, changed: first });
    l.moving(true);
    // Scrolled up: 1 and 2 leave, 5 and 6 come in.
    const now = [3, 4, 5, 6].map((id, i) => seen(bubble(id), i + 2));
    l.viewable({ viewableItems: now, changed: [seen(bubble(1), 0, false), seen(bubble(2), 1, false), seen(bubble(5), 6), seen(bubble(6), 7)] });
    expect(ids(l.store.get())).toEqual([3, 4]); // the ones that left gave theirs up; none added mid-scroll
    l.moving(false);
    expect(ids(l.store.get())).toEqual([3, 4, 5, 6]);
  });

  it('never more than the cap, however many are in view', () => {
    const l = createLiquidRows();
    const many = Array.from({ length: 12 }, (_, i) => seen(bubble(i + 1), i));
    l.viewable({ viewableItems: many, changed: many });
    expect(l.store.get().size).toBe(LIQUID_CAP);
    l.moving(true);
    l.moving(false);
    expect(l.store.get().size).toBe(LIQUID_CAP);
  });
});
