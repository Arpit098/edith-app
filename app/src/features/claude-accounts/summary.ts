// The Settings row's line for Claude accounts: how many, and which one is in use.

import type { AccountsState } from './model';

export function accountsSummary(s: AccountsState): string | null {
  if (s.switch?.state === 'running') return 'Switching…';
  if (!s.loaded) return s.error ? 'Couldn’t load the accounts' : null;
  const n = s.accounts.length;
  if (!n) return 'Not signed in';
  const count = `${n} account${n === 1 ? '' : 's'}`;
  const active = s.accounts.find((a) => a.active);
  return active ? `${count} · ${active.label} active` : count;
}

/** The words the top card of Settings adds to the link state: "Interseqt active". */
export function activeBadge(s: AccountsState): string | null {
  if (s.switch?.state === 'running') return 'Switching account…';
  const active = s.accounts.find((a) => a.active);
  return active ? `${active.label} active` : null;
}
