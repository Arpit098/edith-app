// Attachments in the composer (contracts/attachments.md): picked files upload at once, so sending is
// instant; each shows its progress, can be removed, and retried if its upload failed.

import { ApiError, type Api } from '../../core/api';
import type { MediaPicker, PickedFile } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

export const MAX_ATTACHMENTS = 10; // per message (the server's limit)
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
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
  error: string | null;
}

export interface DraftsState {
  drafts: Draft[];
  picking: boolean;
  error: string | null; // why the last pick couldn't be added
}

/** A sent message's attachment, as its bubble shows it. */
export interface SentAttachment {
  id: string;
  name: string;
  kind: 'image' | 'audio';
  uri: string | null; // local file for the thumbnail (null after a restart or from the server)
}

export interface AttachmentsModel {
  store: Store<DraftsState>;
  add(source: 'camera' | 'library' | 'audio'): Promise<void>;
  retry(key: string): Promise<void>;
  remove(key: string): void;
  /** Ready to send (all uploaded); empty when there are none. */
  ready(): SentAttachment[];
  busy(): boolean;
  clear(): void;
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
  let seq = 0;

  const patch = (key: string, change: Partial<Draft>) =>
    store.set((s) => (s.drafts.some((d) => d.key === key) ? { ...s, drafts: s.drafts.map((d) => (d.key === key ? { ...d, ...change } : d)) } : s));

  async function upload(key: string) {
    const d = store.get().drafts.find((x) => x.key === key);
    if (!d) return;
    patch(key, { status: 'uploading', sent: 0, error: null });
    let last = 0;
    try {
      const r = await api.uploadAttachment({ uri: d.uri, mime: d.mime, name: d.name, size: d.size }, (sent, total) => {
        const t = now();
        if (t - last < PROGRESS_EVERY_MS) return;
        last = t;
        patch(key, { sent, total: total || d.size });
      });
      patch(key, { status: 'ready', id: r.id, sent: d.size, total: d.size }); // ignored if it was removed meanwhile
    } catch (e) {
      patch(key, { status: 'failed', error: uploadError(e) });
    }
  }

  function tooBig(f: PickedFile): boolean {
    return f.size > (f.kind === 'image' ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES);
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
      if (tooBig(file)) {
        store.set((s) => ({ ...s, picking: false, error: uploadError(new ApiError(413, 'too big')) }));
        return;
      }
      const key = `att-${++seq}`;
      const draft: Draft = { key, kind: file.kind, uri: file.uri, name: file.name, mime: file.mime, size: file.size, status: 'uploading', sent: 0, total: file.size, id: null, error: null };
      store.set((s) => ({ ...s, picking: false, drafts: [...s.drafts, draft] }));
      await upload(key);
    },
    retry: (key) => upload(key),
    remove(key) {
      store.set((s) => ({ ...s, drafts: s.drafts.filter((d) => d.key !== key), error: null }));
    },
    ready() {
      const drafts = store.get().drafts;
      if (drafts.some((d) => d.status !== 'ready')) return [];
      return drafts.map((d) => ({ id: d.id!, name: d.name, kind: d.kind, uri: d.uri }));
    },
    busy: () => store.get().drafts.some((d) => d.status === 'uploading'),
    clear() {
      store.set((s) => ({ ...s, drafts: [], error: null }));
    },
  };
}
