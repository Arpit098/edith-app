// The chosen appearance (Settings → Appearance): kept on the phone (the data store) and applied at
// once, with no restart. Loaded at start; until it's read the app shows the defaults (Midnight, 60%
// glass), which is a few milliseconds. A drag on the glass slider changes it many times a second:
// each change shows at once, but it's written once the dragging pauses (SAVE_MS), or at once when
// the app goes to the background (flush), where Android may kill it before the timer fires.
//
// Wallpaper photos are files (WallpaperFiles): the store keeps up to MAX_PHOTOS and deletes a file
// as soon as it's replaced or removed. At start, a kept photo whose file is gone is dropped (the
// background falls back to the theme's own), and, once the saved value has been read, a file
// nothing refers to is deleted (checkFiles).

import type { KeyValueStore, PickedWallpaper, WallpaperFiles } from './ports';
import { createStore, type Store } from './store';
import {
  DEFAULT_APPEARANCE,
  DEFAULT_BACKGROUND,
  DEFAULT_PHOTO_ADJUST,
  isPhotoBackground,
  MAX_PHOTOS,
  normalizeAppearance,
  photoTones,
  type Appearance,
  type Photo,
  type PhotoActions,
} from './theme';

export const APPEARANCE_KEY = 'appearance.v1';
const SAVE_MS = 400;

export interface AppearanceStore {
  store: Store<Appearance>;
  /** Read the saved appearance (a broken or missing one gives the defaults; a lost photo, the theme's own). */
  load(): Promise<void>;
  set(change: Partial<Appearance>): void;
  /** Write a pending change now (the app is going to the background, where it may be killed). */
  flush(): void;
  /** Adding and removing wallpaper photos; absent without a place to keep them (tests, web). */
  photos?: PhotoActions;
  dispose(): void;
}

/** A picked wallpaper as a kept photo: its colours reduced to the ones that matter for text. */
export function photoOf(picked: PickedWallpaper): Photo {
  return { uri: picked.uri, width: picked.width, height: picked.height, tones: photoTones(picked.grid) };
}

/**
 * A new photo, made the background: first among the kept ones (the oldest past MAX_PHOTOS goes,
 * and its file with it: `dropped`). The dim, blur and tint carry over from the photo before; the
 * focus starts in the middle (it's about this picture).
 */
export function withPhoto(a: Appearance, photo: Photo): { change: Partial<Appearance>; dropped: string[] } {
  const all = [photo, ...a.photos.filter((p) => p.uri !== photo.uri)];
  const was = isPhotoBackground(a.background) ? a.background : DEFAULT_PHOTO_ADJUST;
  return {
    change: { photos: all.slice(0, MAX_PHOTOS), background: { kind: 'photo', uri: photo.uri, blur: was.blur, dim: was.dim, tint: was.tint, focus: DEFAULT_PHOTO_ADJUST.focus } },
    dropped: all.slice(MAX_PHOTOS).map((p) => p.uri),
  };
}

/** A kept photo removed; if it was the background, the theme's own takes over. */
export function withoutPhoto(a: Appearance, uri: string): Partial<Appearance> {
  const shown = isPhotoBackground(a.background) && a.background.uri === uri;
  return { photos: a.photos.filter((p) => p.uri !== uri), ...(shown ? { background: DEFAULT_BACKGROUND } : {}) };
}

/** The appearance without the photos whose files are gone (null when none are). */
export function withoutMissing(a: Appearance, exists: (uri: string) => boolean): Appearance | null {
  const kept = a.photos.filter((p) => exists(p.uri));
  if (kept.length === a.photos.length) return null;
  return normalizeAppearance({ ...a, photos: kept }); // a background on a lost photo falls back
}

export function createAppearanceStore(data: KeyValueStore | undefined, wallpapers?: WallpaperFiles): AppearanceStore {
  const store = createStore<Appearance>(DEFAULT_APPEARANCE);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let changed = false; // a change made before the saved one was read wins over it

  const save = () => {
    timer = null;
    void data?.set(APPEARANCE_KEY, JSON.stringify(store.get())).catch((e: unknown) => console.warn('[edith] appearance not saved', e));
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, SAVE_MS);
  };
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      save(); // don't lose the last change
    }
  };
  const set = (change: Partial<Appearance>) => {
    changed = true;
    store.set((a) => normalizeAppearance({ ...a, ...change }));
    later();
  };

  let adding: Promise<boolean> | null = null; // a pick in progress (its file may be written before it's in photos)

  /**
   * At start: drop photos whose files are gone, and delete files nothing refers to. Deleting needs
   * certainty, so it happens only when the saved value was read and parsed (`stored`: its photos);
   * not when the read failed or the value was garbled, where the photos aren't known. It keeps what
   * was saved and what's in memory now, and waits for a pick in progress to land first.
   */
  const checkFiles = (stored: readonly Photo[] | null) => {
    if (!wallpapers) return;
    const fixed = withoutMissing(store.get(), (uri) => wallpapers.exists(uri));
    if (fixed) {
      store.set(fixed);
      later();
    }
    if (!stored) return;
    const prune = () => wallpapers.prune([...new Set([...stored.map((p) => p.uri), ...store.get().photos.map((p) => p.uri)])]);
    if (adding) void adding.then(prune, prune);
    else prune();
  };

  const photos: PhotoActions | undefined = wallpapers && {
    add() {
      // A second tap while the picker is open (or the photo is being saved) joins the first.
      if (adding) return adding;
      const run = (async () => {
        const picked = await wallpapers.pick();
        if (!picked) return false;
        const { change, dropped } = withPhoto(store.get(), photoOf(picked));
        set(change);
        for (const uri of dropped) wallpapers.remove(uri);
        return true;
      })();
      adding = run;
      const done = () => {
        if (adding === run) adding = null;
      };
      run.then(done, done);
      return run;
    },
    remove(uri) {
      set(withoutPhoto(store.get(), uri));
      wallpapers.remove(uri);
    },
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
      let stored: Photo[] | null = null; // the saved photos, when the saved value could be read
      if (raw !== null) {
        try {
          const saved = normalizeAppearance(JSON.parse(raw));
          stored = saved.photos;
          if (!changed) store.set(saved);
        } catch {
          // garbled: keep the defaults; the next change overwrites it
        }
      }
      checkFiles(stored);
    },
    set,
    flush,
    photos,
    dispose: flush,
  };
}
