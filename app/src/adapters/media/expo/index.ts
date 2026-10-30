// Adapter: MediaPicker on Expo's image picker, image manipulator and document picker.
// Every image is re-encoded as JPEG with the long edge at most 2048 px: small uploads, HEIC turned
// into JPEG, and the photo's EXIF (location included) left behind.
//
// Files: each picked file ends up as one copy in cache/attachments/ (the app's own folder). The
// pickers' intermediate copies (the camera's full-size original, the gallery copy, the document
// picker's copy) are deleted at once; the folder is pruned by age and size at startup.

import * as DocumentPicker from 'expo-document-picker';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { MediaPicker, PickedFile } from '../../../core/ports';
import { toPrune } from './prune';

export const LONG_EDGE = 2048;
const JPEG_QUALITY = 0.85;

/** The size to scale to so the long edge is at most LONG_EDGE, or null when it already fits. */
export function fitLongEdge(width: number, height: number, max = LONG_EDGE): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= max) return null;
  return width >= height ? { width: max } : { height: max };
}

function stem(name: string | null | undefined, fallback: string): string {
  const base = (name ?? '').replace(/\.[^.]+$/, '').trim();
  return base || fallback;
}

function extension(name: string): string {
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(name);
  return m ? m[0].toLowerCase() : '';
}

const within = (uri: string, dir: Directory) => uri.startsWith(dir.uri.endsWith('/') ? dir.uri : `${dir.uri}/`);

export function createExpoMediaPicker(): MediaPicker {
  const dir = new Directory(Paths.cache, 'attachments');
  let seq = 0;

  function ensureDir() {
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  }

  /** Move a picker's file into our folder under a unique name. */
  function adopt(uri: string, ext: string): File {
    ensureDir();
    const to = new File(dir, `${Date.now()}-${++seq}${ext}`);
    new File(uri).moveSync(to);
    return to;
  }

  /** Delete a picker's leftover copy. Only ever inside the app's cache: never a file of Arpit's. */
  function deleteCacheCopy(uri: string) {
    try {
      if (!within(uri, Paths.cache)) return;
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      // best effort: prune() and Android's cache trimming catch what's left
    }
  }

  function stat(uri: string): number | null {
    try {
      const f = new File(uri);
      return f.exists ? f.size : null;
    } catch {
      return null;
    }
  }

  return {
    async pickImage(source) {
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) throw new Error('EDITH needs the camera permission to take a photo. Allow it in Android settings → Apps → EDITH.');
      }
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: 'images', quality: 1, allowsEditing: false, exif: false };
      const r = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      const asset = r.canceled ? null : r.assets?.[0];
      if (!asset) return null;
      try {
        const ctx = ImageManipulator.manipulate(asset.uri);
        const fit = fitLongEdge(asset.width, asset.height);
        if (fit) ctx.resize(fit);
        const image = await ctx.renderAsync();
        const out = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
        image.release();
        ctx.release();
        const file = adopt(out.uri, '.jpg');
        const picked: PickedFile = { kind: 'image', uri: file.uri, name: `${stem(asset.fileName, `photo-${Date.now()}`)}.jpg`, mime: 'image/jpeg', size: stat(file.uri) ?? 0 };
        return picked;
      } finally {
        deleteCacheCopy(asset.uri); // the camera's full-size original (or the gallery copy): the JPEG replaces it
      }
    },
    async pickAudio() {
      const r = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: false });
      const asset = r.canceled ? null : r.assets?.[0];
      if (!asset) return null;
      const name = asset.name || `audio-${Date.now()}`;
      const file = adopt(asset.uri, extension(name));
      // The document picker copies into a folder of its own per pick: remove it once empty.
      try {
        const parent = new File(asset.uri).parentDirectory;
        if (within(parent.uri, Paths.cache) && parent.uri !== Paths.cache.uri && parent.list().length === 0) parent.delete();
      } catch {
        // best effort
      }
      return { kind: 'audio', uri: file.uri, name, mime: asset.mimeType ?? 'audio/mpeg', size: stat(file.uri) ?? 0 };
    },
    stat,
    discard(uri) {
      if (within(uri, dir)) deleteCacheCopy(uri);
    },
    prune() {
      try {
        if (!dir.exists) return;
        const files = dir.list().flatMap((x) => (x instanceof File ? [{ file: x, size: x.size, mtime: x.lastModified ?? 0 }] : []));
        for (const f of toPrune(files, Date.now())) f.file.delete();
      } catch {
        // a failed prune only leaves files for next time
      }
    },
  };
}
