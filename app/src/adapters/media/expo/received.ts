// Adapter: ReceivedFiles (files EDITH sends; contracts/attachments.md §4) on expo-file-system, which
// the APK already has, so this ships over the air.
//
// Downloads go to cache/received/<id>/<name>: one folder per id, so two files with the same name never
// meet, and the name stays the server's. A download first lands in a ".part" file and is moved into
// place only when complete, so a cut-off download never looks finished. The folder is pruned by age
// and size at startup (./prune).
//
// Saving uses Android's Storage Access Framework: the folder picker (no storage permission; the
// picked folder's access is kept across restarts), then a new document there, written in chunks.
// Android doesn't let the picker choose the Download folder itself; a folder in it (Download/EDITH)
// is fine. Opening a file in another app would need a FileProvider grant (expo-sharing or
// expo-intent-launcher, both native): not in this APK yet.

import { Directory, File, FileMode, Paths } from 'expo-file-system';

import type { KeyValueStore, ReceivedFiles } from '../../../core/ports';
import { toPrune } from './prune';

const SAVE_DIR_KEY = 'files.saveDir';
const CHUNK = 1024 * 1024;

/** A file name that is safe as one path segment (the server's name, minus separators and controls). */
export function safeName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120);
  return clean || 'file';
}

export function createExpoReceivedFiles(data?: KeyValueStore): ReceivedFiles {
  const root = new Directory(Paths.cache, 'received');

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
      return null; // cancelled
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
        return file.exists && (size < 0 || file.size === size) ? file.uri : null;
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
      const known = await data?.get(SAVE_DIR_KEY).catch(() => null);
      let dir: Directory | null = known ? new Directory(known) : null;
      if (dir) {
        try {
          copyInto(src, dir, name, mime);
          return dir.name || 'your folder';
        } catch {
          dir = null; // the folder is gone or its access was taken back: ask again
        }
      }
      dir = await pickFolder();
      if (!dir) return null;
      copyInto(src, dir, name, mime);
      return dir.name || 'your folder';
    },
    prune() {
      try {
        if (!root.exists) return;
        const files = root.list().flatMap((d) =>
          d instanceof Directory ? d.list().flatMap((x) => (x instanceof File ? [{ file: x, dir: d, size: x.size, mtime: x.lastModified ?? 0 }] : [])) : [],
        );
        for (const f of toPrune(files, Date.now())) {
          f.file.delete();
          if (f.dir.list().length === 0) f.dir.delete();
        }
      } catch {
        // a failed prune only leaves files for next time
      }
    },
  };
}
