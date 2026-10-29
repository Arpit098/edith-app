// Adapter: SecureStorage on expo-secure-store. On Android the values are encrypted with a key held
// in the Android Keystore, and never leave the app's private storage (no backup).

import * as SecureStore from 'expo-secure-store';

import type { SecureStorage } from '../../../core/ports';

export function createSecureStorage(): SecureStorage {
  return {
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) => SecureStore.setItemAsync(key, value),
    remove: (key) => SecureStore.deleteItemAsync(key),
  };
}
