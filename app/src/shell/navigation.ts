// Navigation state: one bottom tab, plus a stack of non-tab screens (tools) opened over it.
// Small enough that a navigation library would add more than it removes.

export interface NavState {
  tab: string;
  stack: string[]; // non-tab screens over the current tab, top last
}

export function navigate(s: NavState, screen: string, tabs: ReadonlySet<string>): NavState {
  if (tabs.has(screen)) return s.tab === screen && !s.stack.length ? s : { tab: screen, stack: [] };
  if (s.stack[s.stack.length - 1] === screen) return s;
  return { tab: s.tab, stack: [...s.stack.filter((x) => x !== screen), screen] };
}

/** Android back: pop a tool screen, else go to the home tab, else null (let Android leave the app). */
export function back(s: NavState, home: string): NavState | null {
  if (s.stack.length) return { tab: s.tab, stack: s.stack.slice(0, -1) };
  if (s.tab !== home) return { tab: home, stack: [] };
  return null;
}

export function current(s: NavState): string {
  return s.stack[s.stack.length - 1] ?? s.tab;
}
