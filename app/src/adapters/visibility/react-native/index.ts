// Adapter: AppVisibility on React Native's AppState ("active" = EDITH is on screen).

import { AppState } from 'react-native';

import type { AppVisibility } from '../../../core/ports';

export function createAppStateVisibility(): AppVisibility {
  return {
    active: () => AppState.currentState === 'active',
    onChange(handler) {
      let last = AppState.currentState === 'active';
      const sub = AppState.addEventListener('change', (s) => {
        const active = s === 'active';
        if (active === last) return; // "inactive" ⇄ "background" is no change for us
        last = active;
        handler(active);
      });
      return () => sub.remove();
    },
  };
}
