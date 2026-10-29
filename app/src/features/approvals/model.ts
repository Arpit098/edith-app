// Pending permission prompts: kept in step with the stream, resynced from /v1/permissions on connect.

import { ApiError, permissionFrom, type Api, type PendingPermission } from '../../core/api';
import type { EventBus } from '../../core/events';
import { str } from '../../core/guards';
import { createStore, type Store } from '../../core/store';

export interface ApprovalsState {
  pending: PendingPermission[]; // oldest first
  answering: Record<string, true>;
}

export interface ApprovalsModel {
  store: Store<ApprovalsState>;
  /** Allow or deny; resolves to a short message for a toast. */
  answer(id: string, allow: boolean): Promise<string>;
  dispose(): void;
}

function without(s: ApprovalsState, id: string): ApprovalsState {
  if (!s.pending.some((p) => p.id === id) && !s.answering[id]) return s;
  const { [id]: _gone, ...answering } = s.answering;
  return { pending: s.pending.filter((p) => p.id !== id), answering };
}

export function createApprovalsModel(bus: EventBus, api: Api): ApprovalsModel {
  const store = createStore<ApprovalsState>({ pending: [], answering: {} });
  let sync = 0; // a newer resync wins over an older one still in flight

  const offs = [
    bus.on(
      'permission.request',
      (e) => {
        const p = permissionFrom(e.data as Record<string, unknown>);
        if (!p.id) return;
        store.set((s) => (s.pending.some((x) => x.id === p.id) ? s : { ...s, pending: [...s.pending, p] }));
      },
      'approvals',
    ),
    bus.on('permission.resolved', (e) => store.set((s) => without(s, str(e.data.id))), 'approvals'),
    bus.on(
      'app.connected',
      () => {
        const mine = ++sync;
        api.permissions().then(
          (pending) => {
            if (mine === sync) store.set((s) => ({ ...s, pending }));
          },
          () => {}, // keep what we have; the next connect tries again
        );
      },
      'approvals',
    ),
  ];

  return {
    store,
    async answer(id, allow) {
      if (store.get().answering[id]) return 'Already sending…';
      store.set((s) => ({ ...s, answering: { ...s.answering, [id]: true } }));
      try {
        await api.answer(id, allow);
        store.set((s) => without(s, id));
        return allow ? '✅ Allowed' : '❌ Denied';
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) {
          store.set((s) => without(s, id));
          return 'That request has expired.';
        }
        store.set((s) => {
          const { [id]: _gone, ...answering } = s.answering;
          return { ...s, answering };
        });
        return `Couldn't answer: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    dispose() {
      offs.forEach((off) => off());
    },
  };
}
