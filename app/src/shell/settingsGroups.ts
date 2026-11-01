// The Settings list's layout: sections into their groups, in a fixed group order, each group sorted
// by `order` then title. Pure, so the order is tested without rendering.

import type { SettingsGroup, SettingsSection } from '../core/feature';

export const GROUPS: readonly { id: SettingsGroup; title: string }[] = [
  { id: 'connection', title: 'Connection' },
  { id: 'notifications', title: 'Notifications' },
  { id: 'voice', title: 'Voice' },
  { id: 'app', title: 'App' },
  { id: 'about', title: 'About' },
  { id: 'more', title: 'More' },
];

export const DEFAULT_ORDER = 100;
export const DEFAULT_ICON = 'cog-outline';

export interface SettingsGroupView {
  id: SettingsGroup;
  title: string;
  sections: SettingsSection[];
}

/** Non-empty groups in GROUPS order. A section without a group (or with one this build doesn't know) goes under More. */
export function groupSections(sections: readonly SettingsSection[]): SettingsGroupView[] {
  const known = new Set(GROUPS.map((g) => g.id));
  const by = new Map<SettingsGroup, SettingsSection[]>();
  for (const s of sections) {
    const id = s.group && known.has(s.group) ? s.group : 'more';
    let list = by.get(id);
    if (!list) by.set(id, (list = []));
    list.push(s);
  }
  const rank = (s: SettingsSection) => s.order ?? DEFAULT_ORDER;
  return GROUPS.filter((g) => by.has(g.id)).map((g) => ({
    ...g,
    sections: by.get(g.id)!.slice().sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title)),
  }));
}
