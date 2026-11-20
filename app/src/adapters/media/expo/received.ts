// Adapter: ReceivedFiles (files EDITH sends; contracts/attachments.md §4) on expo-file-system, with
// expo-intent-launcher (open in the phone's viewer) and expo-sharing (the share sheet).
//
// Downloads go to cache/received/<id>/<name>: one folder per id, so two files with the same name never
// meet, and the name stays the server's. A download first lands in a ".part" file and is moved into
// place only when complete, so a cut-off download never looks finished. The folder is pruned by age
// and size at startup (./prune): nothing older than the server's 7 days stays.
//
// Saving uses Android's Storage Access Framework: the folder picker (no storage permission; the
// picked folder's access is kept across restarts), then a new document there, written in chunks.
// Android doesn't let the picker choose the Download folder itself; a folder in it (Download/EDITH)
// is fine.
//
// Opening: ACTION_VIEW on the file's content:// uri from expo-file-system's FileProvider (it serves
// the app's cache), with FLAG_GRANT_READ_URI_PERMISSION, so only the viewer Arpit picks can read, and
// only that one file (no storage permission). Sharing goes through expo-sharing's own FileProvider and
// the system share sheet. Both are native modules, loaded only when the APK has them (an APK from
// before them has neither; its JS never gets this code over the air, as the fingerprint differs).

import { requireOptionalNativeModule } from 'expo';
import { Directory, File, FileMode, Paths } from 'expo-file-system';

import type { KeyValueStore, ReceivedFiles } from '../../../core/ports';
import { RECEIVED_KEEP_MS, toPrune, usableCopy } from './prune';

const FLAG_GRANT_READ_URI_PERMISSION = 0x00000001; // android.content.Intent
const ACTION_VIEW = 'android.intent.action.VIEW';

const SAVE_DIR_KEY = 'files.saveDir';
export const CACHE_GONE = 'the downloaded copy is gone';
const CHUNK = 1024 * 1024;

/** A file name that is safe as one path segment (the server's name, minus separators and controls). */
export function safeName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120);
  return clean || 'file';
}

/**
 * Whether a save failed because the kept folder's access was taken back (pick again). A folder that is
 * gone is seen by checking it (folderGone), never from a generic "not found", which may be about the
 * cached file instead (pruned: the app downloads it again).
 */
export function folderLost(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /permission|denied|SecurityException/i.test(msg);
}

/** Whether starting the viewer failed because no app on the phone handles that type. */
export function noViewerApp(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /ActivityNotFound|No Activity found/i.test(msg);
}

function folderGone(dir: Directory): boolean {
  try {
    return !dir.exists;
  } catch {
    return true;
  }
}

type IntentLauncher = typeof import('expo-intent-launcher');
type Sharing = typeof import('expo-sharing');

export function createExpoReceivedFiles(data?: KeyValueStore): ReceivedFiles {
  const root = new Directory(Paths.cache, 'received');
  // Lazily required: both modules throw on import when their native side is missing.
  const launcher: IntentLauncher | null = requireOptionalNativeModule('ExpoIntentLauncher') ? (require('expo-intent-launcher') as IntentLauncher) : null;
  const sharing: Sharing | null = requireOptionalNativeModule('ExpoSharing') ? (require('expo-sharing') as Sharing) : null;

  function target(id: string, name: string): { dir: Directory; file: File } {
    const dir = new Directory(root, id);
    return { dir, file: new File(dir, safeName(name)) };
  }

  async function pickFolder(): Promise<Directory | null> {
    try {
      const dir = await Directory.pickDirectoryAsync();
      await data?.set(SAVE_DIR_KEY, dir.uri);
      return dir;
    } catch {
      await data?.remove(SAVE_DIR_KEY).catch(() => {}); // cancelled: forget a folder that no longer works
      return null;
    }
  }

  /** Copy `src` into a new document `name` in `dir`, a chunk at a time (never the whole file in memory). */
  function copyInto(src: File, dir: Directory, name: string, mime: string): void {
    const dest = dir.createFile(name, mime);
    const input = src.open(FileMode.ReadOnly);
    try {
      const output = dest.open(FileMode.Truncate);
      try {
        for (;;) {
          const bytes = input.readBytes(CHUNK);
          if (!bytes.length) break;
          output.writeBytes(bytes);
        }
      } finally {
        output.close();
      }
    } catch (e) {
      try {
        dest.delete(); // no half-written copy left in Arpit's folder
      } catch {
        // best effort
      }
      throw e;
    } finally {
      input.close();
    }
  }

  return {
    cached({ id, name, size }) {
      try {
        const { file } = target(id, name);
        const exists = file.exists;
        const copy = { exists, size: exists ? file.size : 0, mtime: exists ? file.lastModified : null };
        return usableCopy(copy, size, Date.now()) ? file.uri : null;
      } catch {
        return null;
      }
    },
    async download(request, { id, name, size }, onProgress, signal) {
      const { dir, file } = target(id, name);
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const part = new File(dir, `${safeName(name)}.part`);
      try {
        if (part.exists) part.delete();
        await File.downloadFileAsync(request.url, part, {
          headers: request.headers,
          idempotent: true,
          signal,
          onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes),
        });
        if (size >= 0 && part.size !== size) throw new Error('the download was cut short');
        if (file.exists) file.delete();
        part.moveSync(file);
        return file.uri;
      } catch (e) {
        try {
          if (part.exists) part.delete();
        } catch {
          // pruned later
        }
        throw e;
      }
    },
    async readText(uri, maxBytes) {
      const f = new File(uri);
      if (f.size > maxBytes) throw new Error('too big to show');
      return f.text();
    },
    async save(uri, name, mime) {
      const src = new File(uri);
      if (!src.exists) throw new Error(CACHE_GONE); // pruned since: the model downloads it again
      const known = await data?.get(SAVE_DIR_KEY).catch(() => null);
      let dir: Directory | null = known ? new Directory(known) : null;
      if (dir) {
        try {
          copyInto(src, dir, name, mime);
          return dir.name || 'your folder';
        } catch (e) {
          if (!folderLost(e) && !folderGone(dir)) throw e; // a real failure (disk full, …): say it, keep the folder
          dir = null; // the folder is gone or its access was taken back: ask again
        }
      }
      dir = await pickFolder();
      if (!dir) return null;
      copyInto(src, dir, name, mime);
      return dir.name || 'your folder';
    },
    view: launcher
      ? async (uri, mime) => {
          const src = new File(uri);
          if (!src.exists) throw new Error(CACHE_GONE);
          try {
            // Resolves when the viewer returns to the app (its result is always "cancelled").
            await launcher.startActivityAsync(ACTION_VIEW, { data: src.contentUri, type: mime, flags: FLAG_GRANT_READ_URI_PERMISSION });
            return 'opened';
          } catch (e) {
            if (noViewerApp(e)) return 'no-app';
            throw e;
          }
        }
      : undefined,
    share: sharing
      ? async (uri, name, mime) => {
          const src = new File(uri);
          if (!src.exists) throw new Error(CACHE_GONE);
          await sharing.shareAsync(src.uri, { mimeType: mime, dialogTitle: name });
        }
      : undefined,
    prune() {
      try {
        if (!root.exists) return;
        const files = root.list().flatMap((d) =>
          d instanceof Directory ? d.list().flatMap((x) => (x instanceof File ? [{ file: x, dir: d, size: x.size, mtime: x.lastModified ?? 0 }] : [])) : [],
        );
        for (const f of toPrune(files, Date.now(), RECEIVED_KEEP_MS)) {
          f.file.delete();
          if (f.dir.list().length === 0) f.dir.delete();
        }
      } catch {
        // a failed prune only leaves files for next time
      }
    },
  };
}
