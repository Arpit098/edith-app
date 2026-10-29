// Mirrors contracts/events.md. Change that file first, then this one.

export type Origin = 'telegram' | 'app' | 'terminal' | 'system';

export interface EdithEvent<T = Record<string, unknown>> {
  type: string; // e.g. "turn.done"
  ts: number;
  session_id?: string | null;
  origin: Origin;
  data: T;
}

export type EventHandler = (event: EdithEvent) => void;

/** Glob-style subscribe ("turn.*", "*"). A failing handler is logged and never blocks the others. */
export class EventBus {
  private subs: { pattern: RegExp; handler: EventHandler; owner: string }[] = [];

  subscribe(pattern: string, handler: EventHandler, owner = '?'): () => void {
    const re = new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$');
    const sub = { pattern: re, handler, owner };
    this.subs.push(sub);
    return () => {
      this.subs = this.subs.filter((s) => s !== sub);
    };
  }

  publish(event: EdithEvent): void {
    for (const { pattern, handler, owner } of [...this.subs]) {
      if (!pattern.test(event.type)) continue;
      try {
        handler(event);
      } catch (e) {
        console.warn(`[edith] handler from ${owner} failed on ${event.type}`, e);
      }
    }
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
