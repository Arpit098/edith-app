// Settings → Chat: how much the Work cards show (Summary / Steps / Full), kept on the phone.

import type { KeyValueStore } from '../../core/ports';
import { createStore, type Store } from '../../core/store';
import { DEFAULT_WORK_DETAIL, isWorkDetail, type WorkDetail } from './work';

export const WORK_DETAIL_KEY = 'chat.workDetail.v1';

export interface WorkDetailSetting {
  store: Store<WorkDetail>;
  load(): Promise<void>;
  set(d: WorkDetail): void;
}

export function createWorkDetailSetting(data: KeyValueStore | undefined): WorkDetailSetting {
  const store = createStore<WorkDetail>(DEFAULT_WORK_DETAIL);
  let changed = false; // a choice made before the saved one was read wins
  return {
    store,
    async load() {
      try {
        const v = data ? await data.get(WORK_DETAIL_KEY) : null;
        if (!changed && isWorkDetail(v)) store.set(v);
      } catch (e) {
        console.warn('[edith] work detail not read', e);
      }
    },
    set(d) {
      changed = true;
      store.set(d);
      void data?.set(WORK_DETAIL_KEY, d).catch((e: unknown) => console.warn('[edith] work detail not saved', e));
    },
  };
}
