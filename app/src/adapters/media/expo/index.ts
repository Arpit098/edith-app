// Adapter: MediaPicker on Expo's image picker, image manipulator and document picker.
// Every image is re-encoded as JPEG with the long edge at most 2048 px: small uploads, HEIC turned
// into JPEG, and the photo's EXIF (location included) left behind.

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { MediaPicker, PickedFile } from '../../../core/ports';

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

function sizeOf(uri: string): number {
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0; // unknown: the server checks the size anyway
  }
}

export function createExpoMediaPicker(): MediaPicker {
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
      const ctx = ImageManipulator.manipulate(asset.uri);
      const fit = fitLongEdge(asset.width, asset.height);
      if (fit) ctx.resize(fit);
      const image = await ctx.renderAsync();
      const out = await image.saveAsync({ format: SaveFormat.JPEG, compress: JPEG_QUALITY });
      const file: PickedFile = { kind: 'image', uri: out.uri, name: `${stem(asset.fileName, `photo-${Date.now()}`)}.jpg`, mime: 'image/jpeg', size: sizeOf(out.uri) };
      return file;
    },
    async pickAudio() {
      const r = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true, multiple: false });
      const asset = r.canceled ? null : r.assets?.[0];
      if (!asset) return null;
      return { kind: 'audio', uri: asset.uri, name: asset.name || `audio-${Date.now()}`, mime: asset.mimeType ?? 'audio/mpeg', size: asset.size ?? sizeOf(asset.uri) };
    },
  };
}
