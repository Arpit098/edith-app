// The appearance store: read at start (garbled or missing gives the defaults), each change shown at
// once and written once the changes pause, a change made before the read wins, nothing lost on exit.

import { APPEARANCE_KEY, createAppearanceStore, withoutMissing, withoutPhoto, withPhoto } from '../appearance';
import type { PickedWallpaper, WallpaperFiles } from '../ports';
import { DEFAULT_APPEARANCE, DEFAULT_BACKGROUND, DEFAULT_PHOTO_ADJUST, MAX_PHOTOS, resolveTheme, type PhotoBackground } from '../theme';
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

  it('reads what an older app saved (before gradients), and saves gradients, accent and custom backgrounds back whole', async () => {
    const data = new MemoryStorage();
    data.data.set(APPEARANCE_KEY, JSON.stringify({ theme: 'rose', myBubble: 'yellow', edithBubble: null, background: 'dots', glass: 35 }));
    const s = createAppearanceStore(data);
    await s.load();
    expect(s.store.get()).toEqual({ ...DEFAULT_APPEARANCE, theme: 'rose', myBubble: 'yellow', background: 'dots', glass: 35 });
    const custom = { id: 'custom-1', stops: ['#FF7E5F', '#2C1E4A'], angle: 180, kind: 'radial' as const, intensity: 40 };
    s.set({ customGradients: [custom], background: 'custom-1', accent: 'lime', myBubble: 'custom', myGradient: { stops: ['#22A699', '#6C5BD9'], angle: 90 } });
    s.flush();
    const again = createAppearanceStore(data);
    await again.load();
    expect(again.store.get()).toEqual(s.store.get());
    expect(again.store.get()).toMatchObject({ background: 'custom-1', accent: 'lime', myBubble: 'custom' });
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

/** Wallpaper files in memory: what's "on disk", and what was picked/removed/pruned. */
function fakeWallpapers(files: string[] = []) {
  const disk = new Set(files);
  let n = 0;
  const w = {
    disk,
    pruned: [] as string[][],
    next: null as PickedWallpaper | null | 'cancel',
    pick: jest.fn(async (): Promise<PickedWallpaper | null> => {
      if (w.next === 'cancel') return null;
      const uri = `file:///docs/wallpapers/${++n}.jpg`;
      disk.add(uri);
      return w.next ?? { uri, width: 1080, height: 2400, grid: [[1, 1, 1], [0, 0, 0]] };
    }),
    exists: (uri: string) => disk.has(uri),
    remove: jest.fn((uri: string) => void disk.delete(uri)),
    prune: (keep: readonly string[]) => {
      w.pruned.push([...keep]);
      for (const f of [...disk]) if (!keep.includes(f)) disk.delete(f);
    },
  };
  return w satisfies WallpaperFiles & Record<string, unknown>;
}

const PHOTO = { uri: 'file:///docs/wallpapers/a.jpg', width: 1080, height: 1440, tones: ['#405060', '#FFFFFF', '#000000'] };
const ON_PHOTO = { kind: 'photo', uri: PHOTO.uri, blur: 6, dim: 50, focus: 'end', tint: true } as const;

describe('wallpaper photos', () => {
  it('a stored photo background loads back whole, and settings from before photos load with none', async () => {
    const data = new MemoryStorage();
    data.data.set(APPEARANCE_KEY, JSON.stringify({ theme: 'rose', background: 'sunset', glass: 35 })); // the last version's
    const files = fakeWallpapers();
    const s = createAppearanceStore(data, files);
    await s.load();
    expect(s.store.get()).toEqual({ ...DEFAULT_APPEARANCE, theme: 'rose', background: 'sunset', glass: 35, photos: [] });
    files.disk.add(PHOTO.uri); // picked
    s.set({ photos: [PHOTO], background: ON_PHOTO });
    s.flush();
    const again = createAppearanceStore(data, files);
    await again.load();
    expect(again.store.get()).toMatchObject({ photos: [PHOTO], background: ON_PHOTO });
  });

  it('a photo whose file is gone at startup is dropped, the background falls back to the theme’s own, and that is saved', async () => {
    const data = new MemoryStorage();
    const other = { ...PHOTO, uri: 'file:///docs/wallpapers/b.jpg' };
    data.data.set(APPEARANCE_KEY, JSON.stringify({ theme: 'ocean', photos: [PHOTO, other], background: ON_PHOTO }));
    const files = fakeWallpapers([other.uri, 'file:///docs/wallpapers/orphan.jpg']); // a.jpg is gone
    const s = createAppearanceStore(data, files);
    await s.load();
    expect(s.store.get()).toMatchObject({ theme: 'ocean', photos: [other], background: DEFAULT_BACKGROUND });
    expect(() => resolveTheme(s.store.get())).not.toThrow();
    expect(files.pruned).toEqual([[other.uri]]); // the orphan (picked, never saved) is deleted
    expect([...files.disk]).toEqual([other.uri]);
    await jest.advanceTimersByTimeAsync(500);
    expect(JSON.parse(data.data.get(APPEARANCE_KEY)!)).toMatchObject({ photos: [other], background: DEFAULT_BACKGROUND });
  });

  it('nothing saved and no files: the defaults, nothing pruned but strays', async () => {
    const files = fakeWallpapers(['file:///docs/wallpapers/stray.jpg']);
    const s = createAppearanceStore(new MemoryStorage(), files);
    await s.load();
    expect(s.store.get()).toEqual(DEFAULT_APPEARANCE);
    expect(files.disk.size).toBe(0);
  });

  it(`adding makes the photo the background; the ${MAX_PHOTOS} newest are kept and the oldest’s file is deleted`, async () => {
    const files = fakeWallpapers();
    const s = createAppearanceStore(new MemoryStorage(), files);
    await s.load();
    s.set({ background: 'dots' });
    expect(await s.photos!.add()).toBe(true);
    const first = s.store.get();
    expect(first.photos).toHaveLength(1);
    expect(first.photos[0]!.tones[0]).toBe('#808080'); // the mean of white and black patches
    expect(first.background).toEqual({ kind: 'photo', uri: first.photos[0]!.uri, ...DEFAULT_PHOTO_ADJUST });
    s.set({ background: { ...(first.background as PhotoBackground), dim: 60, focus: 'end' } });
    for (let i = 0; i < MAX_PHOTOS; i++) await s.photos!.add();
    const a = s.store.get();
    expect(a.photos.map((p) => p.uri)).toEqual(['file:///docs/wallpapers/4.jpg', 'file:///docs/wallpapers/3.jpg', 'file:///docs/wallpapers/2.jpg']);
    expect(files.remove).toHaveBeenCalledWith('file:///docs/wallpapers/1.jpg');
    expect(files.disk.has('file:///docs/wallpapers/1.jpg')).toBe(false);
    expect(a.background).toMatchObject({ uri: 'file:///docs/wallpapers/4.jpg', dim: 60, focus: 'center' }); // dim carried over, focus fresh
  });

  it('a cancelled pick changes nothing', async () => {
    const files = fakeWallpapers();
    files.next = 'cancel';
    const s = createAppearanceStore(new MemoryStorage(), files);
    expect(await s.photos!.add()).toBe(false);
    expect(s.store.get()).toEqual(DEFAULT_APPEARANCE);
  });

  it('removing deletes the file; removing the shown one falls back to the theme’s own', async () => {
    const files = fakeWallpapers();
    const s = createAppearanceStore(new MemoryStorage(), files);
    await s.photos!.add();
    await s.photos!.add();
    const [shown, older] = s.store.get().photos.map((p) => p.uri) as [string, string];
    s.photos!.remove(older);
    expect(s.store.get().background).toMatchObject({ uri: shown });
    s.photos!.remove(shown);
    expect(s.store.get()).toMatchObject({ photos: [], background: DEFAULT_BACKGROUND });
    expect(files.disk.size).toBe(0);
  });

  it('without a place for files (tests, web) there are no photo actions', () => {
    expect(createAppearanceStore(new MemoryStorage()).photos).toBeUndefined();
  });

  it('withPhoto / withoutPhoto / withoutMissing are pure', () => {
    const a = { ...DEFAULT_APPEARANCE, photos: [PHOTO], background: ON_PHOTO };
    expect(withPhoto(a, PHOTO).dropped).toEqual([]); // the same photo again: moved to the front, nothing dropped
    expect(withoutPhoto(a, 'file:///other.jpg')).toEqual({ photos: [PHOTO] });
    expect(withoutMissing(a, () => true)).toBeNull();
    expect(withoutMissing(a, () => false)).toMatchObject({ photos: [], background: DEFAULT_BACKGROUND });
  });
});
