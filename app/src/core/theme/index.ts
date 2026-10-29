// The app's theme: tokens plus the glass setting the shell decides at runtime.

import { createContext, useContext } from 'react';

export * from './tokens';

/**
 * Whether glass surfaces blur what's behind them. Off below Android 12, in battery saver, and on web
 * where the shell turns it off for honest screenshots of the fallback (?blur=0). Surfaces then use
 * the flat translucent fallback.
 */
export interface GlassSettings {
  blur: boolean;
}

export const GlassContext = createContext<GlassSettings>({ blur: false });

export function useGlass(): GlassSettings {
  return useContext(GlassContext);
}

/** Space the floating header and tab bar take from a screen's content (set by the shell). */
export interface ChromeInsets {
  top: number;
  bottom: number;
}

export const ChromeContext = createContext<ChromeInsets>({ top: 0, bottom: 0 });

export function useChrome(): ChromeInsets {
  return useContext(ChromeContext);
}
