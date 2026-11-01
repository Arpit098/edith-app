// How the Commands page lays out the server's commands (Arpit, 1 Nov: "Commands page also needs
// improvement"): grouped sections like Settings, each row with an icon, a plain name, one line on
// what it does and the /command. The server's list is the source of truth: a command it adds that
// isn't known here still shows, under Other, with its own description.

import type { Command } from '../../core/api';

export interface CommandMeta {
  title: string;
  icon: string;
  group: GroupId;
  /** Used when the server sends no description. */
  description: string;
  /** Asks before running (it interrupts EDITH). */
  confirm?: { title: string; message: string; action: string };
}

export type GroupId = 'daily' | 'conversation' | 'server' | 'other';

const GROUPS: readonly { id: GroupId; title: string }[] = [
  { id: 'daily', title: 'Daily' },
  { id: 'conversation', title: 'Conversation' },
  { id: 'server', title: 'Server' },
  { id: 'other', title: 'Other' },
];

// In the order each group shows them.
const META: Record<string, CommandMeta> = {
  brief: { title: 'Brief', icon: 'text-box-outline', group: 'daily', description: "Today's calendar, mail and reminders" },
  today: { title: 'Today', icon: 'calendar-outline', group: 'daily', description: "Today's calendar" },
  mail: { title: 'Mail', icon: 'email-outline', group: 'daily', description: 'Unread emails that matter' },
  reminders: { title: 'Reminders', icon: 'bell-outline', group: 'daily', description: 'Upcoming reminders' },
  btw: { title: 'By the way', icon: 'call-split', group: 'conversation', description: 'Run a task in parallel' },
  queue: { title: 'Queue', icon: 'playlist-plus', group: 'conversation', description: 'Run a task after the current one' },
  compact: { title: 'Compact', icon: 'arrow-collapse-vertical', group: 'conversation', description: 'Compact the conversation' },
  status: { title: 'Status', icon: 'information-outline', group: 'conversation', description: 'What EDITH is doing' },
  servers: { title: 'Servers', icon: 'server-outline', group: 'server', description: 'Server health check' },
  changes: { title: 'Changes', icon: 'file-document-edit-outline', group: 'server', description: 'Recent file changes' },
  restart: {
    title: 'Restart',
    icon: 'restart',
    group: 'server',
    description: 'Restart the bridge',
    confirm: { title: 'Restart the bridge?', message: 'EDITH goes offline for a few seconds and any running task stops.', action: 'Restart' },
  },
  menu: { title: 'Quick actions', icon: 'gesture-tap-button', group: 'other', description: 'Quick action buttons' },
};
const ORDER = new Map(Object.keys(META).map((k, i) => [k, i]));

/** What a row shows for a command: known ones from META, others from the server's own fields. */
export function metaOf(c: Command): CommandMeta {
  const known = META[c.name];
  const description = c.description.trim() || known?.description || '';
  if (known) return { ...known, description };
  return { title: c.name.charAt(0).toUpperCase() + c.name.slice(1), icon: 'console-line', group: 'other', description };
}

export interface CommandRow {
  command: Command;
  meta: CommandMeta;
}

export interface CommandSection {
  id: GroupId | 'recent';
  title: string;
  rows: CommandRow[];
}

const norm = (s: string) => s.toLowerCase().trim();

/** Matches the name ("brief", "/brief"), the title or the description, ignoring case. */
export function matches(row: CommandRow, query: string): boolean {
  const q = norm(query).replace(/^\//, '');
  if (!q) return true;
  return [row.command.name, row.meta.title, row.meta.description].some((s) => norm(s).includes(q));
}

/**
 * The page's sections: Recent (the last few used, only when not searching), then the groups in
 * order, empty ones left out. Known commands keep META's order; unknown ones the server's.
 */
export function sections(commands: readonly Command[], query = '', recent: readonly string[] = []): CommandSection[] {
  const rows = commands.map((command) => ({ command, meta: metaOf(command) })).filter((r) => matches(r, query));
  const byName = new Map(rows.map((r) => [r.command.name, r]));
  const out: CommandSection[] = [];
  if (!norm(query)) {
    const used = recent.map((n) => byName.get(n)).filter((r): r is CommandRow => !!r);
    if (used.length) out.push({ id: 'recent', title: 'Recent', rows: used });
  }
  const rank = (r: CommandRow) => ORDER.get(r.command.name) ?? Number.MAX_SAFE_INTEGER;
  for (const g of GROUPS) {
    const inGroup = rows.filter((r) => r.meta.group === g.id);
    // A stable sort: unknown commands (equal rank) stay in the server's order.
    inGroup.sort((a, b) => rank(a) - rank(b));
    if (inGroup.length) out.push({ id: g.id, title: g.title, rows: inGroup });
  }
  return out;
}
