// Readers for untrusted wire data (events and API answers): never trust a field's type.

import type { ButtonRows } from './events';

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : v == null ? fallback : String(v);
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function bool(v: unknown): boolean {
  return v === true;
}

/** Button rows from a reply or message.system; malformed rows and buttons are dropped. */
export function buttonRows(v: unknown): ButtonRows {
  if (!Array.isArray(v)) return [];
  const rows: ButtonRows = [];
  for (const row of v) {
    if (!Array.isArray(row)) continue;
    const buttons = row
      .filter((b): b is { label: unknown; action: unknown } => typeof b === 'object' && b !== null)
      .filter((b) => typeof b.label === 'string' && typeof b.action === 'string' && b.action !== '')
      .map((b) => ({ label: b.label as string, action: b.action as string }));
    if (buttons.length) rows.push(buttons);
  }
  return rows;
}
