// Local notifications while EDITH is connected (PLAN.md §4.6): replies and finished tasks, approvals
// (with Allow/Deny that answer without opening the app), reminders and errors. Event-driven; each
// event id or ref notifies at most once, and nothing already on screen is notified.

import type { Api } from '../../core/api';
import type { EdithEvent, EventBus } from '../../core/events';
import { str } from '../../core/guards';
import type { AppVisibility, LocalNotification, NotificationAction, NotificationChannel, Notifier, Transport } from '../../core/ports';

export const SEEN_MAX = 256; // dedupe memory: refs and ids notified lately (oldest forgotten first)
const PREVIEW = 180;
const LIVE = 'edith://live';
const APPROVALS = 'edith://approvals';
/** Shown in the live chat: not notified while Arpit looks at it. */
const CHAT: ReadonlySet<NotificationChannel> = new Set(['replies', 'errors', 'reminders']);

/** One line of plain text for a notification: code blocks and markdown marks out, whitespace folded. */
export function preview(text: string, max = PREVIEW): string {
  const plain = text
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)[#>*_-]+\s/g, '$1')
    .replace(/[*_]{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

const FAILED: Record<string, string> = {
  not_ready: "Claude isn't ready yet. Try again in a moment.",
  crashed: 'Claude stopped unexpectedly.',
  queue_full: 'Too many messages are already waiting.',
};

/** A set that forgets its oldest entries past `max` (Map keeps insertion order). */
class Recent {
  private items = new Map<string, true>();
  constructor(private readonly max: number) {}
  has(key: string): boolean {
    return this.items.has(key);
  }
  add(key: string): void {
    this.items.set(key, true);
    if (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
  }
}

export interface NotificationsModel {
  dispose(): void;
}

export function createNotifications(deps: { bus: EventBus; api: Api; notifier: Notifier; transport: Transport; visibility?: AppVisibility }): NotificationsModel {
  const { bus, api, notifier, transport, visibility } = deps;
  const seen = new Recent(SEEN_MAX);
  const posted = new Map<string, NotificationChannel>(); // tag -> channel, still showing
  let screen = '';
  let asked = false;
  let sync = 0; // a newer resync wins over an older one still in flight

  /** Whether Arpit already sees this channel's news: the app is open on the chat, or (approvals) open at all. */
  function onScreen(channel: NotificationChannel): boolean {
    if (!visibility?.active()) return false;
    return channel === 'approvals' || (CHAT.has(channel) && screen === 'live');
  }

  function post(key: string, n: LocalNotification): void {
    if (seen.has(key)) return;
    seen.add(key); // also when on screen: it was seen there, so it never pops up later
    if (onScreen(n.channel)) return;
    notifier.post(n);
    posted.set(n.tag, n.channel);
  }

  function cancel(tag: string): void {
    if (posted.delete(tag)) notifier.cancel(tag);
  }

  /** What is now on screen needs no notification any more. */
  function clearShown(): void {
    for (const [tag, channel] of [...posted]) if (onScreen(channel)) cancel(tag);
  }

  function answerAction(id: string, allow: boolean): NotificationAction | null {
    const auth = transport.authorized(`/v1/permissions/${encodeURIComponent(id)}`);
    if (!auth) return null;
    return { label: allow ? 'Allow' : 'Deny', request: { method: 'POST', url: auth.url, headers: auth.headers, body: { allow } }, done: allow ? 'Allowed' : 'Denied' };
  }

  function approval(p: { id: string; tool: string; detail: string; lane: unknown }): void {
    if (!p.id) return;
    const actions = [answerAction(p.id, false), answerAction(p.id, true)].filter((a): a is NotificationAction => a !== null);
    post(`perm:${p.id}`, {
      channel: 'approvals',
      tag: `perm:${p.id}`,
      title: `Approve ${p.tool || 'a tool'}?${p.lane === 'side' ? ' (parallel task)' : ''}`,
      text: preview(p.detail, 300) || p.tool,
      link: APPROVALS,
      actions,
    });
  }

  /** A reply, from turn.done or a side lane's message.assistant (both carry the turn's ref). */
  function reply(e: EdithEvent, text: string): void {
    const d = e.data;
    const ref = str(d.ref);
    if (!ref || e.origin !== 'app') return; // replies to Telegram or the terminal go there
    const side = d.lane === 'side';
    const error = d.is_error === true;
    post(`turn:${ref}`, {
      channel: error ? 'errors' : 'replies',
      tag: `turn:${ref}`,
      title: error ? 'EDITH finished with an error' : side ? 'EDITH · parallel task done' : 'EDITH replied',
      text: preview(text) || 'Done.',
      link: LIVE,
    });
  }

  const offs = [
    bus.on('turn.done', (e) => reply(e, str(e.data.display_text ?? e.data.text)), 'notifications'),
    bus.on('message.assistant', (e) => (e.data as Record<string, unknown>).lane === 'side' && reply(e, str(e.data.text)), 'notifications'),
    bus.on(
      'turn.failed',
      (e) => {
        const ref = str(e.data.ref);
        if (!ref || e.origin !== 'app') return;
        const reason = str(e.data.reason);
        post(`turn:${ref}`, {
          channel: 'errors',
          tag: `turn:${ref}`,
          title: "EDITH couldn't finish",
          text: FAILED[reason] ?? (preview(str(e.data.detail || e.data.stderr)) || 'Something went wrong.'),
          link: LIVE,
        });
      },
      'notifications',
    ),
    bus.on(
      'reminder.due',
      (e) => {
        const id = str(e.data.id);
        if (!id) return;
        const key = `rem:${id}:${str(e.data.due)}`; // a repeating reminder fires once per due time
        post(key, { channel: 'reminders', tag: key, title: e.data.late ? 'Reminder (late)' : 'Reminder', text: preview(str(e.data.text), 300), link: LIVE });
      },
      'notifications',
    ),
    bus.on('permission.request', (e) => approval({ id: str(e.data.id), tool: str(e.data.tool), detail: str(e.data.detail), lane: e.data.lane }), 'notifications'),
    bus.on('permission.resolved', (e) => cancel(`perm:${str(e.data.id)}`), 'notifications'),
    bus.on(
      'app.connected',
      () => {
        if (!asked) {
          asked = true;
          void notifier.ensurePermission().catch(() => false);
        }
        // Approvals asked or answered while we were away.
        const mine = ++sync;
        api.permissions().then(
          (pending) => {
            if (mine !== sync) return;
            const ids = new Set(pending.map((p) => `perm:${p.id}`));
            for (const [tag, channel] of [...posted]) if (channel === 'approvals' && !ids.has(tag)) cancel(tag);
            pending.forEach(approval);
          },
          () => {}, // keep what we have; the next connect tries again
        );
      },
      'notifications',
    ),
    bus.on(
      'app.screen',
      (e) => {
        screen = str(e.data.name);
        clearShown();
      },
      'notifications',
    ),
    visibility?.onChange((active) => active && clearShown()) ?? (() => {}),
  ];

  return {
    dispose() {
      offs.forEach((off) => off());
    },
  };
}
