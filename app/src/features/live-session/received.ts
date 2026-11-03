// Files EDITH sends (its SEND_FILE lines; contracts/attachments.md §4). The server offers each one as
// {id, name, size, mime} in `sent_files`; tapping its chip downloads it with GET /v1/files/<id> into
// the app's cache (ports.files), with progress, then shows it: an image full screen, a text file in a
// reader, anything else saved to the folder Arpit picked (Android's folder picker, once). A long press
// saves any of them. Opening in another app (a PDF viewer) or the share sheet needs a native module the
// APK doesn't have yet; until then, saving is how a PDF or Office file leaves the app.

import type { Transport, ReceivedFiles } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

/** One file on EDITH's bubble. `id` null: the server won't offer it (`error` says why) or is too old to. */
export interface SentFile {
  id: string | null;
  name: string;
  size: number | null;
  mime: string;
  error: string | null;
}

export const SERVER_TOO_OLD = 'Update the server on edith to download files in the app.';
export const TEXT_MAX_BYTES = 1024 * 1024; // a bigger text file is saved, not shown
export const THUMB_MAX_BYTES = 5 * 1024 * 1024; // images up to this download by themselves for the thumbnail
const PROGRESS_EVERY_MS = 250;

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|toml|ini|xml|html?|css|js|ts|tsx|py|sh|sql|diff|patch)$/i;
const IMAGE_MIME = /^image\/(jpeg|png|gif|webp|bmp)$/; // what Android's image view draws (not HEIC everywhere)

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * An event's files: `sent_files` when the server has them, else the bare `files` paths (an older
 * server: shown, but not downloadable).
 */
export function sentFilesOf(data: Record<string, unknown>): SentFile[] {
  const offered = data.sent_files;
  if (Array.isArray(offered)) {
    return offered.flatMap((f): SentFile[] => {
      if (!f || typeof f !== 'object') return [];
      const o = f as Record<string, unknown>;
      const name = typeof o.name === 'string' && o.name ? o.name : 'file';
      const id = typeof o.id === 'string' && /^[0-9a-f]{32}$/.test(o.id) ? o.id : null;
      const size = typeof o.size === 'number' && Number.isFinite(o.size) && o.size >= 0 ? o.size : null;
      const mime = typeof o.mime === 'string' && o.mime ? o.mime : 'application/octet-stream';
      const error = id ? null : typeof o.error === 'string' && o.error ? o.error : 'not available';
      return [{ id, name, size, mime, error }];
    });
  }
  const paths = Array.isArray(data.files) ? data.files.filter((p): p is string => typeof p === 'string' && p !== '') : [];
  return paths.map((p) => ({ id: null, name: baseName(p), size: null, mime: 'application/octet-stream', error: SERVER_TOO_OLD }));
}

/** How a downloaded file is shown when tapped. */
export type View = 'image' | 'text' | 'save';

export function viewOf(f: Pick<SentFile, 'name' | 'mime' | 'size'>): View {
  if (IMAGE_MIME.test(f.mime)) return 'image';
  const texty = f.mime.startsWith('text/') || f.mime === 'application/json' || TEXT_EXT.test(f.name);
  if (texty && (f.size ?? 0) <= TEXT_MAX_BYTES) return 'text';
  return 'save';
}

export interface FileState {
  status: 'downloading' | 'ready' | 'failed';
  written: number;
  total: number;
  uri: string | null;
  error: string | null;
}

/** What the viewer shows: an image or a text file, full screen. */
export interface Viewing {
  file: SentFile;
  uri: string;
  view: 'image' | 'text';
  text: string | null; // for text: its contents (the first TEXT_MAX_BYTES)
}

export interface ReceivedState {
  files: Record<string, FileState>;
  viewing: Viewing | null;
}

export interface ReceivedModel {
  store: Store<ReceivedState>;
  /** Whether files can be downloaded here at all (not in tests or on web). */
  available: boolean;
  /** Tap: download if needed, then show or save it. Resolves to a line for a toast, or null. */
  open(file: SentFile): Promise<string | null>;
  /** Long press: download if needed, then save it to the folder. */
  save(file: SentFile): Promise<string | null>;
  /** Download (for a thumbnail) without showing it; nothing if it's here or on its way. */
  prefetch(file: SentFile): void;
  close(): void;
  dispose(): void;
}

/** Why a download failed, said plainly. */
export function downloadError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/\b404\b/.test(msg)) return 'No longer on edith (changed, removed or over 7 days old). Ask EDITH to send it again.';
  if (/\b401\b/.test(msg)) return 'edith refused the token. Check Settings → Server connection.';
  if (/abort|cancel/i.test(msg)) return 'Download cancelled.';
  return "Couldn't download it. Check the connection to edith and try again.";
}

export function createReceivedModel({ transport, files }: { transport: Transport; files?: ReceivedFiles }): ReceivedModel {
  const store = createStore<ReceivedState>({ files: {}, viewing: null });
  const running = new Map<string, Promise<string | null>>();
  const aborts = new Set<AbortController>();
  let disposed = false;

  function setFile(id: string, change: Partial<FileState>) {
    store.set((s) => {
      const old: FileState = s.files[id] ?? { status: 'downloading', written: 0, total: 0, uri: null, error: null };
      return { ...s, files: { ...s.files, [id]: { ...old, ...change } } };
    });
  }

  /** The local copy, downloading it first if needed; null (with the reason in the store) on failure. */
  function fetch(file: SentFile): Promise<string | null> {
    const id = file.id;
    if (!id || !files) return Promise.resolve(null);
    const meta = { id, name: file.name, size: file.size ?? -1 };
    const here = files.cached(meta);
    if (here) {
      if (store.get().files[id]?.uri !== here) setFile(id, { status: 'ready', uri: here, written: meta.size, total: meta.size, error: null });
      return Promise.resolve(here);
    }
    const already = running.get(id);
    if (already) return already;
    const request = transport.authorized(`/v1/files/${id}`);
    if (!request) {
      setFile(id, { status: 'failed', error: 'Not connected to edith.' });
      return Promise.resolve(null);
    }
    const abort = new AbortController();
    aborts.add(abort);
    let last = 0;
    setFile(id, { status: 'downloading', written: 0, total: file.size ?? 0, uri: null, error: null });
    const job = files
      .download(
        request,
        meta,
        (written, total) => {
          const now = Date.now();
          if (now - last < PROGRESS_EVERY_MS || disposed) return;
          last = now;
          setFile(id, { written, total: total > 0 ? total : (file.size ?? 0) });
        },
        abort.signal,
      )
      .then(
        (uri) => {
          if (!disposed) setFile(id, { status: 'ready', uri, written: file.size ?? 0, error: null });
          return uri;
        },
        (e: unknown) => {
          if (!disposed) setFile(id, { status: 'failed', error: downloadError(e) });
          return null;
        },
      )
      .finally(() => {
        running.delete(id);
        aborts.delete(abort);
      });
    running.set(id, job);
    return job;
  }

  async function saveCopy(file: SentFile, uri: string): Promise<string | null> {
    try {
      const folder = await files!.save(uri, file.name, file.mime);
      return folder === null ? null : `Saved ${file.name} to ${folder}`;
    } catch {
      return `Couldn't save ${file.name}. Try again, and pick a folder EDITH can write to.`;
    }
  }

  function unavailable(file: SentFile): string | null {
    if (!file.id) return file.error ?? 'Not available.';
    if (!files) return 'Files open only in the Android app.';
    return null;
  }

  return {
    store,
    available: !!files,
    async open(file) {
      const no = unavailable(file);
      if (no) return no;
      const uri = await fetch(file);
      if (!uri) return store.get().files[file.id!]?.error ?? null;
      if (disposed) return null;
      const view = viewOf(file);
      if (view === 'save') return saveCopy(file, uri);
      let text: string | null = null;
      if (view === 'text') {
        try {
          text = await files!.readText(uri, TEXT_MAX_BYTES);
        } catch {
          return saveCopy(file, uri); // not readable as text after all
        }
      }
      if (!disposed) store.set((s) => ({ ...s, viewing: { file, uri, view, text } }));
      return null;
    },
    async save(file) {
      const no = unavailable(file);
      if (no) return no;
      const uri = await fetch(file);
      if (!uri) return store.get().files[file.id!]?.error ?? null;
      return saveCopy(file, uri);
    },
    prefetch(file) {
      if (!file.id || !files || (file.size ?? Infinity) > THUMB_MAX_BYTES) return;
      const st = store.get().files[file.id];
      if (st && st.status !== 'ready') return; // on its way, or failed (a tap retries)
      void fetch(file);
    },
    close() {
      store.set((s) => (s.viewing ? { ...s, viewing: null } : s));
    },
    dispose() {
      disposed = true;
      for (const a of aborts) a.abort();
      aborts.clear();
      running.clear();
    },
  };
}
