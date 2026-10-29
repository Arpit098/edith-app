// Conversations: list, switch (resume), rename and start new.

import type { Api, Session } from '../../core/api';
import type { EventBus } from '../../core/events';
import { str } from '../../core/guards';
import { createStore, type Store } from '../../core/store';

export interface SessionsState {
  list: Session[];
  loading: boolean;
  error: string | null;
  switching: { ref: string; id: string } | null;
}

export interface SessionsModel {
  store: Store<SessionsState>;
  refresh(): Promise<void>;
  /** Each returns a short message for a toast, or null. */
  resume(id: string): Promise<string | null>;
  newSession(): Promise<string>;
  rename(id: string, title: string): Promise<string | null>;
  dispose(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createSessionsModel(bus: EventBus, api: Api, notify: (text: string) => void): SessionsModel {
  const store = createStore<SessionsState>({ list: [], loading: false, error: null, switching: null });
  let inFlight: Promise<void> | null = null;
  let again = false;

  /** At most one request at a time; refreshes asked for meanwhile collapse into one more. */
  function refresh(): Promise<void> {
    if (inFlight) {
      again = true;
      return inFlight;
    }
    store.set((s) => ({ ...s, loading: true }));
    inFlight = (async () => {
      do {
        again = false;
        try {
          const list = await api.sessions();
          store.set((s) => ({ ...s, list, error: null }));
        } catch (e) {
          store.set((s) => ({ ...s, error: message(e) }));
        }
      } while (again);
      store.set((s) => ({ ...s, loading: false }));
      inFlight = null;
    })();
    return inFlight;
  }

  // A switch's events can beat the answer to its POST (a quick "busy"): keep the last few by ref,
  // so resume() can replay them once it knows its ref.
  const early = new Map<string, { texts: string[]; done: boolean }>();
  function note(ref: string): { texts: string[]; done: boolean } {
    let n = early.get(ref);
    if (!n) {
      n = { texts: [], done: false };
      early.set(ref, n);
      if (early.size > 20) early.delete(early.keys().next().value!);
    }
    return n;
  }

  const offs = [
    bus.on('app.connected', () => void refresh(), 'sessions'),
    bus.on('session.changed', () => void refresh(), 'sessions'),
    bus.on(
      'command.reply',
      (e) => {
        // The switch's own messages ("🔄 Switching to…", "Already in that conversation", …).
        const ref = str(e.data.ref);
        const text = str(e.data.text);
        if (store.get().switching?.ref === ref) {
          if (text) notify(text);
        } else if (ref.startsWith('app:switch:')) {
          note(ref).texts.push(text);
        }
      },
      'sessions',
    ),
    bus.on(
      'session.switched',
      (e) => {
        // Always the last event of a switch, whatever its result.
        const ref = str(e.data.ref);
        if (store.get().switching?.ref === ref) store.set((s) => ({ ...s, switching: null }));
        else if (ref.startsWith('app:switch:')) note(ref).done = true;
      },
      'sessions',
    ),
  ];

  return {
    store,
    refresh,
    async resume(id) {
      if (store.get().switching) return 'Already switching…';
      try {
        const { ref } = await api.resume(id);
        const seen = early.get(ref);
        early.delete(ref);
        seen?.texts.filter(Boolean).forEach(notify);
        if (!seen?.done) store.set((s) => ({ ...s, switching: { ref, id } }));
        return null;
      } catch (e) {
        return `Couldn't switch: ${message(e)}`;
      }
    },
    async newSession() {
      try {
        if ((await api.newSession()) === 'busy') return "EDITH is in the middle of a task. Stop it first, then start a new one.";
        void refresh();
        return '🆕 Fresh conversation started';
      } catch (e) {
        return `Couldn't start one: ${message(e)}`;
      }
    },
    async rename(id, title) {
      const t = title.trim();
      if (!t) return 'Enter a name';
      try {
        const r = await api.rename(id, t);
        store.set((s) => ({ ...s, list: s.list.map((x) => (x.session_id === id ? { ...x, title: r.title } : x)) }));
        return null;
      } catch (e) {
        return `Couldn't rename: ${message(e)}`;
      }
    },
    dispose() {
      offs.forEach((off) => off());
    },
  };
}
