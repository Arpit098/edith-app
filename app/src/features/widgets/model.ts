// The last-message widget's snapshot writer (contracts/widgets.md). While the app is connected
// (open, or held by its foreground service), each reply, alert and status change on the bus is
// written through the HomeWidgets port, which redraws the widget at once. While it isn't, edith
// pushes the news and the native side folds each push into the same snapshot, so here every
// write starts from what is saved (read back first) and never from a copy kept in memory.
//
// Event-driven only: nothing polls or ticks. Writes happen only when something the widget shows
// changes (a new line, the state, the approval waiting).

import { oneLine } from '../../common/format';
import type { Api } from '../../core/api';
import type { EdithEvent, EventBus } from '../../core/events';
import { num, str } from '../../core/guards';
import type { HomeWidgets, WidgetMessage, WidgetSnapshot, WidgetState } from '../../core/ports';
import { createStore, type Store } from '../../core/store';

export const MAX_MESSAGES = 3;
export const MAX_TEXT = 300; // the native side cuts there too (and a push's text is at most this)
/**
 * A long turn's own events (turn.progress) rewrite `at` this often, at most: the widget calls a
 * "working" it hasn't heard about for 3 hours "not known", which a live turn must never become.
 */
export const REFRESH_S = 15 * 60;
const SEEN_MAX = 64; // lines already written, by key (a turn's ref, an approval's id), oldest forgotten first

/** A line for the widget and the key that keeps it from being written twice. */
export interface Line {
  key: string;
  text: string;
  alert: boolean;
  ts: number; // unix seconds
}

/** The line an event adds to the widget, or null for events that add none. */
export function lineOf(e: EdithEvent): Line | null {
  const d = e.data as Record<string, unknown>;
  const ts = e.ts;
  switch (e.type) {
    case 'turn.done': {
      const ref = str(d.ref);
      if (!ref) return null;
      const text = oneLine(str(d.display_text ?? d.text), MAX_TEXT) || 'Done.';
      return d.is_error === true ? { key: `turn:${ref}`, text: `⚠️ ${text}`, alert: true, ts } : { key: `turn:${ref}`, text, alert: false, ts };
    }
    case 'message.assistant': {
      // A parallel task's answer arrives as its message (its turn.done carries the same ref).
      const ref = str(d.ref);
      const text = oneLine(str(d.text), MAX_TEXT);
      return d.lane === 'side' && ref && text ? { key: `turn:${ref}`, text, alert: false, ts } : null;
    }
    case 'turn.failed': {
      const ref = str(d.ref);
      if (!ref) return null;
      const detail = oneLine(str(d.detail || d.stderr), MAX_TEXT);
      return { key: `turn:${ref}`, text: `⚠️ EDITH couldn't finish${detail ? `: ${detail}` : ''}`, alert: true, ts };
    }
    case 'permission.request': {
      const id = str(d.id);
      return id ? { key: `perm:${id}`, text: approvalText(str(d.tool), str(d.detail)), alert: true, ts } : null;
    }
    case 'reminder.due': {
      const id = str(d.id);
      const text = oneLine(str(d.text), MAX_TEXT);
      return id && text ? { key: `rem:${id}:${str(d.due)}`, text: `⏰ ${text}`, alert: true, ts } : null;
    }
    default:
      return null;
  }
}

/** As a push shows an approval ("🔐 <title> <text>"). */
function approvalText(tool: string, detail: string): string {
  return oneLine(`🔐 Approve ${tool || 'a tool'}? ${detail}`, MAX_TEXT);
}

/** `line` among `messages` (newest first), in time order, at most MAX_MESSAGES. */
export function withLine(messages: readonly WidgetMessage[], line: Line): WidgetMessage[] {
  const m: WidgetMessage = { text: line.text, ts: line.ts, alert: line.alert };
  const at = messages.findIndex((x) => x.ts <= line.ts);
  const next = at < 0 ? [...messages, m] : [...messages.slice(0, at), m, ...messages.slice(at)];
  return next.slice(0, MAX_MESSAGES);
}

/** EDITH's state, from the stream and resynced on each connect. */
interface Status {
  runs: Set<string>; // turns running, by ref
  lanes: boolean; // lane.status: the main lane busy or a side lane running
  approvals: Map<string, string>; // waiting on Arpit, by id (arrival order): the widget's line for it
}

function stateOf(s: Status): WidgetState {
  if (s.approvals.size) return 'waiting';
  return s.runs.size || s.lanes ? 'working' : 'idle';
}

function permissionOf(s: Status): WidgetSnapshot['permission'] {
  const first = s.approvals.entries().next();
  return first.done ? null : { id: first.value[0], text: first.value[1] };
}

/** Folds a status event into `s`; true when it changed. */
export function applyStatus(s: Status, e: EdithEvent): boolean {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'turn.started': {
      const ref = str(d.ref);
      if (!ref || s.runs.has(ref)) return false;
      s.runs.add(ref);
      return true;
    }
    case 'turn.done':
    case 'turn.failed':
    case 'turn.stopped':
      return s.runs.delete(str(d.ref));
    case 'lane.status': {
      const busy = d.main === 'busy' || num(d.side) > 0;
      const changed = busy !== s.lanes || (!busy && s.runs.size > 0);
      s.lanes = busy;
      if (!busy) s.runs.clear(); // nothing runs anywhere: drop any run whose end we missed
      return changed;
    }
    case 'permission.request': {
      const id = str(d.id);
      if (!id || s.approvals.has(id)) return false;
      s.approvals.set(id, approvalText(str(d.tool), str(d.detail)));
      return true;
    }
    case 'permission.resolved':
      return s.approvals.delete(str(d.id));
    default:
      return false;
  }
}

export interface WidgetsState {
  showText: boolean; // Settings → Widgets → "Show message text in widgets" (on by default)
}

export interface WidgetsModel {
  store: Store<WidgetsState>;
  setShowText(on: boolean): void;
  dispose(): void;
}

export function createWidgetsModel(deps: { bus: EventBus; api: Api; widgets: HomeWidgets; now?: () => number }): WidgetsModel {
  const { bus, api, widgets } = deps;
  const now = deps.now ?? (() => Date.now() / 1000);
  const store = createStore<WidgetsState>({ showText: widgets.showText() });
  const status: Status = { runs: new Set(), lanes: false, approvals: new Map() };
  const seen = new Map<string, true>(); // insertion-ordered: the oldest key goes first past SEEN_MAX
  let sync = 0; // a newer resync wins over an older one still in flight

  /** Writes the snapshot with `line` added, if the widget would show anything new. */
  function write(line: Line | null): void {
    const base = widgets.read();
    const state = stateOf(status);
    const permission = permissionOf(status);
    const at = now();
    const same =
      !!base &&
      base.state === state &&
      base.permission?.id === permission?.id &&
      !(state === 'working' && at - base.at >= REFRESH_S);
    if (!line && same) return;
    widgets.write({
      v: 1,
      at,
      state,
      messages: line ? withLine(base?.messages ?? [], line) : (base?.messages ?? []),
      permission,
      hidden: !store.get().showText,
    });
  }

  function onEvent(e: EdithEvent): void {
    const changed = applyStatus(status, e);
    let line = lineOf(e);
    if (line) {
      if (seen.has(line.key)) line = null;
      else {
        seen.set(line.key, true);
        if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value!);
      }
    }
    // turn.progress changes nothing shown, but keeps a long turn from going stale (write() decides).
    if (line || changed || e.type === 'turn.progress') write(line);
  }

  const types = ['turn.started', 'turn.progress', 'turn.done', 'turn.failed', 'turn.stopped', 'lane.status', 'message.assistant', 'permission.request', 'permission.resolved', 'reminder.due'];
  const offs = types.map((t) => bus.subscribe(t, onEvent, 'widgets'));
  offs.push(
    bus.on(
      'app.connected',
      () => {
        // What changed while the stream was down (pushes told the widget about it, maybe not all).
        const mine = ++sync;
        Promise.all([api.status(), api.permissions()]).then(
          ([st, pending]) => {
            if (mine !== sync) return;
            status.runs = new Set(st.runs.map((r) => r.ref).filter(Boolean));
            status.lanes = st.main === 'busy';
            status.approvals = new Map(pending.filter((p) => p.id).map((p) => [p.id, approvalText(p.tool, p.detail)]));
            write(null);
          },
          () => {}, // keep what we have; the next connect tries again
        );
      },
      'widgets',
    ),
  );

  return {
    store,
    setShowText(on) {
      if (store.get().showText === on) return;
      store.set({ showText: on });
      widgets.setShowText(on); // off also wipes the texts already saved
    },
    dispose() {
      offs.forEach((off) => off());
    },
  };
}
