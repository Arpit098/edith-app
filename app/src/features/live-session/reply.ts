// Swipe to reply (plans/ui-next.md §1): what a quote holds, how a message becomes one and how a
// quote finds its original again. ui/SwipeToReply (the gesture) and LiveScreen draw it; the model
// sends the quote as `replying_to` (contracts/events.md).

import type { Item } from './model';

/** Characters of the replied-to message that are sent and shown: the server's cap (server/edith/common/text.py QUOTE_MAX). */
export const QUOTE_MAX = 300;

/** The message a reply refers to. `from` is null when not known (a reply from another device whose original isn't loaded). */
export interface Quote {
  text: string;
  from: 'edith' | 'arpit' | null;
}

/**
 * One line, at most QUOTE_MAX characters (code points: an emoji is never cut in half), cut with "…":
 * the same rule the server applies, so both sides agree.
 */
export function quoteText(text: string): string {
  const one = text.split(/\s+/).filter(Boolean).join(' ');
  const chars = Array.from(one);
  return chars.length > QUOTE_MAX ? `${chars.slice(0, QUOTE_MAX - 1).join('').trimEnd()}…` : one;
}

/**
 * A quote reduced for comparing: one line, the server's "］" (it stands in for "]" inside the prompt's
 * brackets) back to "]", and no trailing "…" (a cut quote is a prefix of its original).
 */
function comparable(text: string): string {
  const q = quoteText(text).replace(/］/g, ']');
  return q.endsWith('…') ? q.slice(0, -1).trimEnd() : q;
}

/** What swiping this message attaches, or null for rows that can't be replied to (tools, diffs, notices). */
export function quoteOf(item: Item): Quote | null {
  if (item.kind === 'assistant') {
    const text = quoteText(item.text);
    return text ? { text, from: 'edith' } : null;
  }
  if (item.kind !== 'user') return null;
  // A photo or recording without words is quoted by its file names.
  const text = quoteText(item.text) || quoteText(item.attachments.map((a) => `📎 ${a.name}`).join(' '));
  return text ? { text, from: 'arpit' } : null;
}

/**
 * Whether `item` is the message `quote` refers to. Both are normalised first (a Telegram reply's
 * quote keeps its newlines and runs to 1500 characters; ours are one line of 300), then either may
 * be the cut one: it matches when one starts with the other.
 */
function quotes(item: Item, quote: string): boolean {
  const q = comparable(quote);
  const own = quoteOf(item);
  if (!q || !own) return false;
  const mine = comparable(own.text);
  return !!mine && (mine.startsWith(q) || q.startsWith(mine));
}

/**
 * The index of the message a reply quotes: the newest matching one older than the reply (items are
 * newest first), or anywhere when the reply itself isn't given or shown. -1 when it isn't loaded.
 */
export function findQuoted(items: Item[], quote: string, replyId: number | null = null): number {
  const from = replyId === null ? -1 : items.findIndex((x) => x.id === replyId);
  for (let i = from + 1; i < items.length; i++) if (quotes(items[i]!, quote)) return i;
  return -1;
}

/**
 * A send that answers the quoted message (`reply`) and clears it, as the Send button does: voice's
 * auto-send goes through this, so speaking right after a swipe replies too.
 */
export function sendWithReply<O extends { replyTo?: Quote | null }>(
  reply: { get(): Quote | null; set(v: Quote | null): void },
  send: (text: string, opts: O) => Promise<void>,
): (text: string, opts: O) => Promise<void> {
  return (text, opts) => {
    const replyTo = reply.get();
    reply.set(null);
    return send(text, { ...opts, replyTo });
  };
}

/** Who wrote the quoted message, from the messages loaded; null when it isn't among them. */
export function quoteFrom(items: Item[], quote: string): Quote['from'] {
  const i = findQuoted(items, quote);
  return i < 0 ? null : (quoteOf(items[i]!)?.from ?? null);
}
