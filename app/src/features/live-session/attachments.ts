// Attachments in the composer (contracts/attachments.md): picked files upload at once, so sending is
// instant; each shows its progress, can be removed (which cancels its upload and deletes its file),
// and retried if its upload failed.

import { ApiError, type Api } from '../../core/api';
import type { MediaPicker, PickedFile } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

// The server's limits, byte for byte (server/edith/adapters/frontends/app_api/attachments.py:
// MAX_PER_MESSAGE = 10, MAX_IMAGE_BYTES = 20 * 1024 * 1024, MAX_BYTES = 25 * 1024 * 1024 for any
// file, KEEP_SECONDS = 7 * 86400). Binary megabytes: "20 MB" here means 20 MiB, as there.
export const MAX_ATTACHMENTS = 10;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const ID_LIFETIME_S = 7 * 86400; // an attachment id is valid this long after its upload
const PROGRESS_EVERY_MS = 250; // progress updates the UI at most 4 times a second

export interface Draft {
  key: string;
  kind: 'image' | 'audio';
  uri: string;
  name: string;
  mime: string;
  size: number;
  status: 'uploading' | 'ready' | 'failed';
  sent: number;
  total: number;
  id: string | null; // the server's attachment id, once uploaded
  uploaded: number | null; // when (epoch seconds): the id expires ID_LIFETIME_S later
  error: string | null;
}

export interface DraftsState {
  drafts: Draft[];
  picking: boolean;
  error: string | null; // why the last pick couldn't be added
}

/** A sent message's attachment, as its bubble shows it. */
export interface SentAttachment {
  id: string; // '' for attachments from the server (Telegram, history): they have only a path
  name: string;
  kind: 'image' | 'audio';
  // This phone's copy, for the thumbnail. Kept in the outbox across restarts, so it can point at a
  // file that's gone by now (pruned): the bubble then shows the name chip. Null from the server.
  uri: string | null;
  uploaded?: number; // epoch seconds (absent in outboxes saved before it existed: the message's time is used)
}

export interface AttachmentsModel {
  store: Store<DraftsState>;
  add(source: 'camera' | 'library' | 'audio'): Promise<void>;
  retry(key: string): Promise<void>;
  remove(key: string): void;
  /**
   * Hand the drafts over for sending and empty the strip, or null (and nothing changes) while any
   * isn't uploaded yet: an attachment is never dropped from a message silently.
   */
  take(): SentAttachment[] | null;
  busy(): boolean;
  dispose(): void;
}

/** What went wrong with an upload, said plainly. */
export function uploadError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.status) {
      case 404:
        return 'Attachments need a server update on edith.';
      case 415:
        return "edith doesn't take this kind of file (images: JPEG, PNG, WebP, HEIC; audio: MP3, M4A, OGG, WAV, AAC).";
      case 413:
        return 'Too big for edith (images 20 MB, audio 25 MB).';
      case 0:
        return e.message === 'timed out' ? 'The upload took too long. Try again on a better connection.' : "Can't reach edith. Is Tailscale on?";
    }
    return `Upload failed: ${e.message}`;
  }
  return `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
}

export function createAttachmentsModel(deps: { api: Api; media?: MediaPicker; now?: () => number }): AttachmentsModel {
  const { api, media } = deps;
  const now = deps.now ?? Date.now;
  const store = createStore<DraftsState>({ drafts: [], picking: false, error: null });
  const uploads = new Map<string, AbortController>(); // key → its upload in flight
  let seq = 0;

  const patch = (key: string, change: Partial<Draft>) =>
    store.set((s) => (s.drafts.some((d) => d.key === key) ? { ...s, drafts: s.drafts.map((d) => (d.key === key ? { ...d, ...change } : d)) } : s));

  async function upload(key: string) {
    const d = store.get().drafts.find((x) => x.key === key);
    if (!d || uploads.has(key)) return;
    const abort = new AbortController();
    uploads.set(key, abort);
    patch(key, { status: 'uploading', sent: 0, error: null });
    let last = 0;
    try {
      const r = await api.uploadAttachment(
        { uri: d.uri, mime: d.mime, name: d.name, size: d.size },
        {
          signal: abort.signal,
          onProgress: (sent, total) => {
            const t = now();
            if (t - last < PROGRESS_EVERY_MS) return;
            last = t;
            patch(key, { sent, total: total || d.size });
          },
        },
      );
      patch(key, { status: 'ready', id: r.id, uploaded: Math.floor(now() / 1000), sent: d.size, total: d.size });
    } catch (e) {
      if (!abort.signal.aborted) patch(key, { status: 'failed', error: uploadError(e) }); // removed: nothing to show
    } finally {
      uploads.delete(key);
    }
  }

  /** Why this file can't be attached, or null. The size is the file's real size on disk. */
  function refuse(f: PickedFile): string | null {
    if (!(f.size > 0)) return "Couldn't read this file. Pick it again.";
    if (f.size > (f.kind === 'image' ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES)) return uploadError(new ApiError(413, 'too big'));
    return null;
  }

  function drop(key: string) {
    uploads.get(key)?.abort();
    const d = store.get().drafts.find((x) => x.key === key);
    if (d) media?.discard(d.uri);
  }

  return {
    store,
    async add(source) {
      if (!media) return;
      if (store.get().drafts.length >= MAX_ATTACHMENTS) {
        store.set((s) => ({ ...s, error: `At most ${MAX_ATTACHMENTS} attachments per message.` }));
        return;
      }
      store.set((s) => ({ ...s, picking: true, error: null }));
      let file: PickedFile | null;
      try {
        file = source === 'audio' ? await media.pickAudio() : await media.pickImage(source);
      } catch (e) {
        store.set((s) => ({ ...s, picking: false, error: e instanceof Error ? e.message : String(e) }));
        return;
      }
      if (!file) {
        store.set((s) => ({ ...s, picking: false })); // cancelled
        return;
      }
      // A picker that couldn't tell the size: stat the file, so the cap and the upload timeout hold.
      if (!(file.size > 0)) file = { ...file, size: media.stat(file.uri) ?? 0 };
      const why = refuse(file);
      if (why) {
        media.discard(file.uri);
        store.set((s) => ({ ...s, picking: false, error: why }));
        return;
      }
      const key = `att-${++seq}`;
      const draft: Draft = { key, kind: file.kind, uri: file.uri, name: file.name, mime: file.mime, size: file.size, status: 'uploading', sent: 0, total: file.size, id: null, uploaded: null, error: null };
      store.set((s) => ({ ...s, picking: false, drafts: [...s.drafts, draft] }));
      await upload(key);
    },
    retry: (key) => upload(key),
    remove(key) {
      drop(key);
      store.set((s) => ({ ...s, drafts: s.drafts.filter((d) => d.key !== key), error: null }));
    },
    take() {
      const drafts = store.get().drafts;
      if (drafts.some((d) => d.status !== 'ready' || !d.id)) return null;
      store.set((s) => ({ ...s, drafts: [], error: null }));
      // Sent: the server holds the files now. Images stay on disk as the bubble's thumbnail (pruned
      // later); audio files have no use here any more.
      for (const d of drafts) if (d.kind === 'audio') media?.discard(d.uri);
      return drafts.map((d) => ({ id: d.id!, name: d.name, kind: d.kind, uri: d.kind === 'image' ? d.uri : null, uploaded: d.uploaded ?? Math.floor(now() / 1000) }));
    },
    busy: () => store.get().drafts.some((d) => d.status === 'uploading'),
    dispose() {
      for (const a of uploads.values()) a.abort();
      uploads.clear();
    },
  };
}
