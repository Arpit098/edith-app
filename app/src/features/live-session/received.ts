// Files EDITH sends (its SEND_FILE lines; contracts/attachments.md §4). The server offers each one as
// {id, name, size, mime} in `sent_files`; tapping its chip downloads it with GET /v1/files/<id> into
// the app's cache (ports.files), with progress, then shows it: an image full screen, a text file in a
// reader, anything else (PDF, Office, zip, …) in the phone's own app for its type. When no app opens
// that type, Arpit is offered Share or Save instead. A long press offers Share and Save for any file:
// the share sheet, or the folder Arpit picked (Android's folder picker, once).

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
export const VIEW_MAX_CHARS = 200_000; // the reader shows this much; "Save to see all" for the rest
export const ROW_MAX_CHARS = 2_000; // a longer line is shown as several rows (one huge Text freezes the UI)

/** A text file as the reader's rows: lines, long ones in pieces, at most VIEW_MAX_CHARS in all. */
export function viewRows(text: string, maxChars = VIEW_MAX_CHARS, rowMax = ROW_MAX_CHARS): { rows: string[]; cut: boolean } {
  const cut = text.length > maxChars;
  const rows: string[] = [];
  for (const line of (cut ? text.slice(0, maxChars) : text).split('\n')) {
    if (line.length <= rowMax) rows.push(line);
    else for (let i = 0; i < line.length; i += rowMax) rows.push(line.slice(i, i + rowMax));
  }
  return { rows, cut };
}

/** The text the server gives a reply of only SEND_FILE lines ("📎 name" each), for older apps. */
export function fileOnlyText(files: SentFile[]): string {
  return files.map((f) => `📎 ${f.name}`).join('\n');
}

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

/** How a downloaded file is shown when tapped: in the app, or in the phone's viewer for its type. */
export type View = 'image' | 'text' | 'external';

export function viewOf(f: Pick<SentFile, 'name' | 'mime' | 'size'>): View {
  if (IMAGE_MIME.test(f.mime)) return 'image';
  const texty = f.mime.startsWith('text/') || f.mime === 'application/json' || TEXT_EXT.test(f.name);
  if (texty && (f.size ?? 0) <= TEXT_MAX_BYTES) return 'text';
  return 'external';
}

/** Types by extension, for a file the server could only call application/octet-stream. */
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  apk: 'application/vnd.android.package-archive',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  html: 'text/html',
  htm: 'text/html',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
};

function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/**
 * The type Android's viewer is asked for: the server's type (from the name, contracts/attachments.md
 * §4) without parameters, made specific from the extension when it is generic. Text that would open
 * in the app but is too big goes out as text/plain (few phones have an app for text/markdown or
 * JSON); CSV, TSV, HTML, calendar and contact files keep theirs (spreadsheet, browser, calendar and
 * contacts apps take them).
 */
const KEPT_TEXT = new Set(['text/csv', 'text/tab-separated-values', 'text/html', 'text/calendar', 'text/vcard', 'text/x-vcard']);

export function viewerMime(name: string, mime: string): string {
  let m = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (!m.includes('/') || m === 'application/octet-stream') m = EXT_MIME[extOf(name)] ?? (TEXT_EXT.test(name) ? 'text/plain' : 'application/octet-stream');
  if (KEPT_TEXT.has(m)) return m;
  if (m.startsWith('text/') || m === 'application/json' || m === 'application/xml') return 'text/plain';
  return m;
}

/**
 * Never opened from the chat (Share or Save instead): an app package would start installing an app.
 * By type, and by name whatever type the server gave (split APKs, bundles and store formats).
 */
const NOT_OPENED = new Set(['application/vnd.android.package-archive']);
const NOT_OPENED_EXT = /\.(apk|apks|xapk|apkm|aab)$/i;

export function neverOpened(name: string, mime: string): boolean {
  return NOT_OPENED.has(mime) || NOT_OPENED_EXT.test(name);
}

/** What Arpit is told when no app on the phone opens a file's type. */
export function noViewerMessage(name: string): string {
  const ext = extOf(name);
  return `No app on this phone opens ${ext ? `.${ext} files` : 'this file'}. Share it to another app, or save it to a folder.`;
}

/** A tap's answer: a line for a toast (or nothing), or "no app opens this" with Share/Save to offer. */
export type Outcome = string | null | { noViewer: string };

export function isNoViewer(o: Outcome): o is { noViewer: string } {
  return typeof o === 'object' && o !== null;
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
  /** Tap: download if needed, then show it here or in the phone's viewer (resolves when Arpit is back). */
  open(file: SentFile): Promise<Outcome>;
  /** Download if needed, then save it to the folder. Resolves to a line for a toast, or null. */
  save(file: SentFile): Promise<string | null>;
  /** Download if needed, then the share sheet. Resolves to a line for a toast, or null. */
  share(file: SentFile): Promise<string | null>;
  /** Whether the share sheet is there (the APK has it). */
  canShare: boolean;
  /** Download (for a thumbnail) without showing it; nothing if it's here or on its way. */
  prefetch(file: SentFile): void;
  close(): void;
  dispose(): void;
}

/** Why a download failed, said plainly. */
export const EXPIRED = 'This file has expired (files are kept 7 days). Ask EDITH to send it again.';
export const OFFLINE = "Can't reach edith. Check you're online and on Tailscale, then tap to retry.";
const NETWORK = /UnknownHost|Unable to resolve host|ConnectException|Failed to connect|NoRouteToHost|SocketTimeout|timed? ?out|Network request failed|network is unreachable|ENETUNREACH|ECONNREFUSED|EHOSTUNREACH/i;

export function downloadError(e: unknown): string {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  // 404: the id is over 7 days old, or the file changed or went away since (the server can't tell which).
  if (/\b404\b/.test(msg)) return EXPIRED;
  if (/\b401\b/.test(msg)) return 'edith refused the token. Check Settings → Server connection.';
  if (/abort|cancel/i.test(msg)) return 'Download cancelled.';
  if (NETWORK.test(msg)) return OFFLINE;
  return "Couldn't download it. Check the connection to edith and try again.";
}

/** Why the viewer or the share sheet didn't open, said plainly. */
export function launchError(what: 'open' | 'share', name: string, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/already started|ActivityAlreadyStarted/i.test(msg)) return 'Another app is still opening. Try again in a moment.';
  return `Couldn't ${what} ${name}${msg ? `: ${msg}` : '.'}`;
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

  /**
   * Run `act` on the local copy. When it fails because the copy was pruned meanwhile, download it
   * again (once) and retry; other failures go to `fail`.
   */
  async function withCopy<T>(file: SentFile, uri: string, act: (uri: string) => Promise<T>, fail: (e: unknown) => T, again = true): Promise<T | string> {
    try {
      return await act(uri);
    } catch (e) {
      if (again && file.id && !files!.cached({ id: file.id, name: file.name, size: file.size ?? -1 })) {
        setFile(file.id, { status: 'failed', uri: null });
        const fresh = await fetch(file);
        if (fresh) return withCopy(file, fresh, act, fail, false);
        const why = store.get().files[file.id]?.error; // the download's own reason (expired, offline)
        if (why) return why;
      }
      return fail(e);
    }
  }

  function saveCopy(file: SentFile, uri: string): Promise<string | null> {
    return withCopy<string | null>(
      file,
      uri,
      async (u) => {
        const folder = await files!.save(u, file.name, file.mime);
        return folder === null ? null : `Saved ${file.name} to ${folder}`;
      },
      (e) => `Couldn't save ${file.name}: ${e instanceof Error && e.message ? e.message : String(e)}`,
    );
  }

  function shareCopy(file: SentFile, uri: string): Promise<string | null> {
    return withCopy<string | null>(
      file,
      uri,
      async (u) => {
        await files!.share!(u, file.name, viewerMime(file.name, file.mime));
        return null;
      },
      (e) => launchError('share', file.name, e),
    );
  }

  /** The phone's viewer for it; Share/Save are offered when no app opens the type (or the APK can't open). */
  function viewCopy(file: SentFile, uri: string): Promise<Outcome> {
    const mime = viewerMime(file.name, file.mime);
    const view = files!.view;
    if (!view) return Promise.resolve({ noViewer: noViewerMessage(file.name) });
    if (neverOpened(file.name, mime)) return Promise.resolve({ noViewer: `${file.name} isn't opened from the chat. Share it, or save it to a folder.` });
    return withCopy<Outcome>(
      file,
      uri,
      async (u) => ((await view(u, mime)) === 'no-app' ? { noViewer: noViewerMessage(file.name) } : null),
      (e) => launchError('open', file.name, e),
    );
  }

  function unavailable(file: SentFile): string | null {
    if (!file.id) return file.error ?? 'Not available.';
    if (!files) return 'Files open only in the Android app.';
    return null;
  }

  return {
    store,
    available: !!files,
    canShare: !!files?.share,
    async open(file) {
      const no = unavailable(file);
      if (no) return no;
      const uri = await fetch(file);
      if (!uri) return store.get().files[file.id!]?.error ?? null;
      if (disposed) return null;
      const view = viewOf(file);
      if (view === 'external') return viewCopy(file, uri);
      let text: string | null = null;
      if (view === 'text') {
        try {
          text = await files!.readText(uri, TEXT_MAX_BYTES);
        } catch {
          return viewCopy(file, uri); // not readable as text after all
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
    async share(file) {
      const no = unavailable(file);
      if (no) return no;
      if (!files!.share) return 'Sharing needs the latest app update.';
      const uri = await fetch(file);
      if (!uri) return store.get().files[file.id!]?.error ?? null;
      return shareCopy(file, uri);
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
