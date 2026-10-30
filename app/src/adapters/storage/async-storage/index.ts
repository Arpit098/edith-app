// Adapter: KeyValueStore on AsyncStorage (SQLite on Android: each set is one atomic write, no
// per-value size warning like SecureStore's). For app data that isn't secret, e.g. the outbox.

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { KeyValueStore } from '../../../core/ports';

export function createAsyncStorage(prefix = 'edith:'): KeyValueStore {
  return {
    get: (key) => AsyncStorage.getItem(prefix + key),
    set: (key, value) => AsyncStorage.setItem(prefix + key, value),
    remove: (key) => AsyncStorage.removeItem(prefix + key),
  };
}
