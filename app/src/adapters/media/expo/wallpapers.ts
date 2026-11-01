// Adapter: WallpaperFiles on Expo's image picker, image manipulator and file system.
//
// The gallery opens through the system's photo picker: no permission is asked for (the camera isn't
// used). A picked photo is re-encoded once as JPEG with its long edge at most PHOTO_LONG_EDGE (about
// a screen; the EXIF, location included, is left behind) into documents/wallpapers/, which Android
// never clears. It's also shrunk to a tiny grid (PHOTO_GRID), read back as PNG, for its colours:
// the theme checks the text against them. The picker's own copy is deleted at once.

import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';

import type { PickedWallpaper, WallpaperFiles } from '../../../core/ports';
import { PHOTO_GRID, PHOTO_JPEG_QUALITY, PHOTO_LONG_EDGE } from '../../../core/theme/photos';
import { fitLongEdge } from './index';
import { base64Bytes, decodePng } from './png';

const nameOf = (uri: string) => uri.slice(uri.lastIndexOf('/') + 1);
const inside = (uri: string, dir: Directory) => uri.startsWith(dir.uri.endsWith('/') ? dir.uri : `${dir.uri}/`);

/** Delete a file if it's inside `dir` (never one of Arpit's own); best effort. */
function deleteIn(uri: string, dir: Directory) {
  try {
    if (!inside(uri, dir)) return;
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // a leftover is pruned next start (wallpapers/) or trimmed by Android (cache)
  }
}

/** The photo's colours on the grid; empty if they can't be read (the theme then assumes a white photo). */
async function gridOf(uri: string): Promise<PickedWallpaper['grid']> {
  let out: string | undefined;
  try {
    const ctx = ImageManipulator.manipulate(uri).resize({ width: PHOTO_GRID.width, height: PHOTO_GRID.height });
    const image = await ctx.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.PNG, base64: true });
    image.release();
    ctx.release();
    out = saved.uri;
    return saved.base64 ? decodePng(base64Bytes(saved.base64)).pixels : [];
  } catch (e) {
    console.warn('[edith] wallpaper colours not read', e);
    return [];
  } finally {
    if (out) deleteIn(out, Paths.cache);
  }
}

/** Undefined where there are no app documents to keep photos in (web): the tile isn't offered. */
export function createExpoWallpapers(): WallpaperFiles | undefined {
  if (Platform.OS === 'web') return undefined;
  const dir = new Directory(Paths.document, 'wallpapers');
  let seq = 0;

  return {
    async pick() {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 1, allowsEditing: false, exif: false });
      const asset = r.canceled ? null : r.assets?.[0];
      if (!asset) return null;
      let saved: string | undefined;
      try {
        const ctx = ImageManipulator.manipulate(asset.uri);
        const fit = fitLongEdge(asset.width, asset.height, PHOTO_LONG_EDGE);
        if (fit) ctx.resize(fit);
        const image = await ctx.renderAsync();
        const out = await image.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_JPEG_QUALITY });
        const { width, height } = image;
        image.release();
        ctx.release();
        saved = out.uri;
        const grid = await gridOf(out.uri);
        if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
        const file = new File(dir, `${Date.now()}-${++seq}.jpg`);
        new File(out.uri).moveSync(file);
        saved = undefined; // moved: nothing left in the cache
        return { uri: file.uri, width, height, grid };
      } finally {
        if (saved) deleteIn(saved, Paths.cache);
        deleteIn(asset.uri, Paths.cache); // the picker's copy: the JPEG replaces it
      }
    },
    exists(uri) {
      try {
        return new File(uri).exists;
      } catch {
        return false;
      }
    },
    remove(uri) {
      deleteIn(uri, dir);
    },
    prune(keep) {
      try {
        if (!dir.exists) return;
        // By name: a uri can be spelt more than one way (file:/ or file:///), a name can't.
        const kept = new Set(keep.map(nameOf));
        for (const f of dir.list()) if (f instanceof File && !kept.has(nameOf(f.uri))) f.delete();
      } catch {
        // a failed prune only leaves files for next time
      }
    },
  };
}
