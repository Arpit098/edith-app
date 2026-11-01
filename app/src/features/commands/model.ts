// Commands tool: every server command with app help (/today, /mail, /reminders, /brief, …), run
// from the app, with their replies and buttons.

import type { Api, Command, Reply } from '../../core/api';
import type { ButtonRows, EventBus } from '../../core/events';
import { buttonRows, str } from '../../core/guards';
import type { KeyValueStore } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

const MAX_OUTPUT = 100;
export const RECENT_KEY = 'commands.recent';
const MAX_RECENT = 3;
// Commands that make no sense from this screen: the app has its own UI for them.
const HIDDEN = new Set(['start', 'help', 'sessions', 'resume', 'name', 'new', 'stop']);

export interface OutputEntry {
  id: number;
  command: string;
  text: string;
  buttons: ButtonRows;
  note: string | null;
}

export interface CommandsState {
  commands: Command[] | null; // null until loaded
  loading: boolean;
  error: string | null;
  running: string | null; // the command waiting for its answer
  output: OutputEntry[]; // newest first
  seq: number;
  recent: string[]; // the last commands run from here, newest first (kept on the phone only)
}

export interface CommandsModel {
  store: Store<CommandsState>;
  load(force?: boolean): Promise<void>;
  run(name: string, args?: string): Promise<string | null>;
  press(entryId: number, action: string): Promise<string | null>;
  clear(): void;
  dispose(): void;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The saved recents, or none if they're missing or unreadable. */
function parseRecent(raw: string | null): string[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

export function createCommandsModel(bus: EventBus, api: Api, storage?: KeyValueStore): CommandsModel {
  const store = createStore<CommandsState>({ commands: null, loading: false, error: null, running: null, output: [], seq: 0, recent: [] });
  const refs = new Map<string, string>(); // our request refs -> command name, for later replies

  // Recents: read once at start; a run before the read lands wins over what was saved.
  let touched = false;
  if (storage) {
    void storage.get(RECENT_KEY).then(
      (raw) => !touched && store.set((s) => ({ ...s, recent: parseRecent(raw) })),
      () => {}, // no recents is fine
    );
  }
  function used(name: string) {
    touched = true;
    const recent = [name, ...store.get().recent.filter((n) => n !== name)].slice(0, MAX_RECENT);
    store.set((s) => ({ ...s, recent }));
    storage?.set(RECENT_KEY, JSON.stringify(recent)).catch(() => {}); // best effort: only a convenience
  }

  function add(command: string, replies: Reply[]) {
    if (!replies.length) return;
    store.set((s) => {
      let seq = s.seq;
      const fresh = replies.map((r) => ({ id: ++seq, command, text: r.text, buttons: r.buttons, note: null }));
      return { ...s, seq, output: [...fresh.reverse(), ...s.output].slice(0, MAX_OUTPUT) };
    });
  }

  function remember(ref: string, command: string) {
    if (!ref) return;
    refs.set(ref, command);
    if (refs.size > 50) refs.delete(refs.keys().next().value!);
  }

  async function load(force = false) {
    const s = store.get();
    if (s.loading || (s.commands && !force)) return;
    store.set((x) => ({ ...x, loading: true }));
    try {
      const commands = (await api.commands()).filter((c) => !HIDDEN.has(c.name));
      store.set((x) => ({ ...x, commands, error: null, loading: false }));
    } catch (e) {
      store.set((x) => ({ ...x, error: message(e), loading: false }));
    }
  }

  const offs = [
    bus.on(
      'command.reply',
      (e) => {
        const command = refs.get(str(e.data.ref));
        if (command) add(command, [{ text: str(e.data.text), buttons: buttonRows(e.data.buttons) }]);
      },
      'commands',
    ),
    // After a reconnect the server may have restarted with other features: reload if we had a list.
    bus.on('app.connected', () => void (store.get().commands && load(true)), 'commands'),
  ];

  return {
    store,
    load,
    async run(name, args = '') {
      if (store.get().running) return 'Wait for the last one to answer';
      store.set((s) => ({ ...s, running: name }));
      try {
        const r = await api.run(name, args.trim());
        remember(r.ref, name);
        used(name);
        add(name, r.replies);
        return null;
      } catch (e) {
        return `/${name} failed: ${message(e)}`;
      } finally {
        store.set((s) => ({ ...s, running: null }));
      }
    },
    async press(entryId, action) {
      const entry = store.get().output.find((o) => o.id === entryId);
      try {
        const r = await api.press(action);
        remember(r.ref, entry?.command ?? '');
        store.set((s) => ({ ...s, output: s.output.map((o) => (o.id === entryId ? { ...o, buttons: [], note: r.note ?? o.note } : o)) }));
        add(entry?.command ?? '', r.replies);
        return r.toast;
      } catch (e) {
        return `Couldn't press it: ${message(e)}`;
      }
    },
    clear() {
      store.set((s) => ({ ...s, output: [] }));
    },
    dispose() {
      offs.forEach((off) => off());
    },
  };
}
