// Appearance's sheet as data: the toolbar → sheet → collapse / expand / back / drag rules, and the
// draft that a slider's drag writes (only real changes reach the preview).

import { createDraft } from '../draft';
import { backHandled, FLING, initialSheet, sheetAnnouncement, sheetReducer, snapFor, TOOLS, type SheetAction, type SheetState } from '../sheet';

const run = (actions: SheetAction[], from: SheetState = initialSheet) => actions.reduce(sheetReducer, from);

describe('the sheet', () => {
  it('starts closed: the toolbar and the whole preview', () => {
    expect(initialSheet).toEqual({ tool: null, snap: 'collapsed' });
    expect(backHandled(initialSheet)).toBe(false); // back leaves the page
  });

  it('a tool opens its controls at half; another switches; its own button closes them', () => {
    expect(run([{ type: 'pick', tool: 'glass' }])).toEqual({ tool: 'glass', snap: 'half' });
    expect(run([{ type: 'pick', tool: 'glass' }, { type: 'pick', tool: 'accent' }])).toEqual({ tool: 'accent', snap: 'half' });
    expect(run([{ type: 'pick', tool: 'glass' }, { type: 'pick', tool: 'glass' }])).toEqual({ tool: 'glass', snap: 'collapsed' });
  });

  it('collapse keeps the tool for expand; expand with none opens the first', () => {
    const closed = run([{ type: 'pick', tool: 'photo' }, { type: 'collapse' }]);
    expect(closed).toEqual({ tool: 'photo', snap: 'collapsed' });
    expect(sheetReducer(closed, { type: 'expand' })).toEqual({ tool: 'photo', snap: 'half' });
    expect(sheetReducer(initialSheet, { type: 'expand' })).toEqual({ tool: TOOLS[0]!.id, snap: 'half' });
    expect(sheetReducer(closed, { type: 'collapse' })).toBe(closed); // nothing to do: same state
  });

  it('Android back closes the sheet first, then leaves', () => {
    const open = run([{ type: 'pick', tool: 'bubbles' }]);
    expect(backHandled(open)).toBe(true);
    const closed = sheetReducer(open, { type: 'back' });
    expect(closed.snap).toBe('collapsed');
    expect(backHandled(closed)).toBe(false);
  });

  it('a drag rests at the nearer snap point, or goes the way it was flung', () => {
    expect(snapFor(0.7, 0)).toBe('half');
    expect(snapFor(0.3, 0)).toBe('collapsed');
    expect(snapFor(0.2, FLING)).toBe('half'); // flung up from low down
    expect(snapFor(0.9, -FLING)).toBe('collapsed'); // flung down from high up
    const open = run([{ type: 'pick', tool: 'theme' }]);
    expect(sheetReducer(open, { type: 'settle', progress: 0.2, velocity: 0 }).snap).toBe('collapsed');
    expect(sheetReducer(initialSheet, { type: 'settle', progress: 0.8, velocity: 0 })).toEqual({ tool: 'theme', snap: 'half' });
    // A drag that ends where it started is the same state: TalkBack hears nothing new.
    expect(sheetReducer(open, { type: 'settle', progress: 0.9, velocity: 0 })).toBe(open);
    expect(sheetReducer(initialSheet, { type: 'settle', progress: 0.1, velocity: 0 })).toBe(initialSheet);
  });

  it('says what changed, for TalkBack', () => {
    expect(sheetAnnouncement(run([{ type: 'pick', tool: 'glass' }]))).toBe('Glass controls open');
    expect(sheetAnnouncement(run([{ type: 'pick', tool: 'glass' }, { type: 'collapse' }]))).toBe('Controls closed');
  });

  it('the tools: most used first, Reset last', () => {
    expect(TOOLS.map((t) => t.id)).toEqual(['theme', 'background', 'photo', 'bubbles', 'accent', 'glass', 'reset']);
  });
});

describe('the draft', () => {
  it('passes on only real changes: a drag’s repeated value redraws nothing', () => {
    const d = createDraft();
    const seen: unknown[] = [];
    d.store.subscribe(() => seen.push(d.store.get()));
    d.put({ glass: 40 });
    d.put({ glass: 40 }); // the same rounded value from the next touch move
    d.put({ background: { kind: 'photo', uri: 'a', blur: 4, dim: 30, focus: 'center', tint: false } });
    d.put({ background: { kind: 'photo', uri: 'a', blur: 4, dim: 30, focus: 'center', tint: false } }); // equal, new object
    d.put(null);
    d.put(null);
    expect(seen).toHaveLength(3);
  });
});
