// Adapter: HomeWidgets on our native module android-modules/edith-widget (the EDITH bar and the
// last-message widget). The snapshot crosses as JSON; the native side checks and trims it again.

import { requireOptionalNativeModule } from 'expo';

import type { HomeWidgets, WidgetMessage, WidgetSnapshot, WidgetState } from '../../../core/ports';

interface NativeWidget {
  read(): string;
  write(json: string): void;
  showText(): boolean;
  setShowText(on: boolean): void;
}

const STATES: ReadonlySet<string> = new Set<WidgetState>(['working', 'idle', 'waiting']);
const MAX_MESSAGES = 3;

/** The saved JSON as a snapshot; null when it's empty, malformed or from another version. */
export function parseSnapshot(raw: string | null | undefined): WidgetSnapshot | null {
  if (!raw) return null;
  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    o = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  if (o.v !== undefined && o.v !== 1) return null;
  const at = typeof o.at === 'number' ? o.at : 0;
  if (!at) return null; // never written (the native empty snapshot)
  const messages: WidgetMessage[] = (Array.isArray(o.messages) ? o.messages : [])
    .slice(0, MAX_MESSAGES)
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({ text: typeof m.text === 'string' ? m.text : '', ts: typeof m.ts === 'number' ? m.ts : 0, alert: m.alert === true }));
  const p = o.permission as Record<string, unknown> | null | undefined;
  const permission = p && typeof p.id === 'string' && p.id ? { id: p.id, text: typeof p.text === 'string' ? p.text : '' } : null;
  return {
    v: 1,
    at,
    state: typeof o.state === 'string' && STATES.has(o.state) ? (o.state as WidgetState) : 'idle',
    messages,
    permission,
    hidden: o.hidden === true,
  };
}

/** Null where the native module isn't built in (jest, web). */
export function createAndroidWidgets(): HomeWidgets | null {
  const native = requireOptionalNativeModule<NativeWidget>('EdithWidget');
  if (!native) return null;
  return {
    read: () => parseSnapshot(native.read()),
    write: (s) => native.write(JSON.stringify(s)),
    showText: () => native.showText(),
    setShowText: (on) => native.setShowText(on),
  };
}
