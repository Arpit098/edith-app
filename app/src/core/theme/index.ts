// The app's theme: tokens, the active theme (Settings → Appearance) and the glass setting the shell
// decides at runtime.
//
// Neutral tokens (text, danger, spacing…) are the same in every theme and stay module constants
// (`colors`, `space`…). What a theme changes (background, accent, bubbles, glass) comes from the
// active Theme: `useTheme()` in a component, or `themedStyles(t => StyleSheet.create(…))` for a
// sheet built once per theme. `colors.accent`/`colors.bg` remain Midnight's, for code outside React.

import { createContext, useContext, type ComponentType } from 'react';

import { DEFAULT_APPEARANCE, resolveTheme, type Appearance, type Theme } from './themes';
import type { Scheme } from './tokens';

export * from './contrast';
export * from './themes';
export * from './tokens';

/** The active theme; Midnight with the defaults when nothing provides one (tests, previews). */
export const ThemeContext = createContext<Theme>(resolveTheme(DEFAULT_APPEARANCE));

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

/**
 * A style sheet that depends on the theme: built on first use for each theme and kept, so a
 * re-render costs a lookup. `const useStyles = themedStyles((t) => StyleSheet.create({...}))`, then
 * `const ts = useStyles()` in the component.
 */
export function themedStyles<T>(make: (t: Theme) => T): () => T {
  const built = new WeakMap<Theme, T>();
  return function useThemedStyles() {
    const t = useTheme();
    let s = built.get(t);
    if (!s) built.set(t, (s = make(t)));
    return s;
  };
}

/** Wallpaper photos: pick one from the gallery (it becomes the background), or remove a kept one. */
export interface PhotoActions {
  /** False when Arpit cancels the picker. Throws if the photo couldn't be read or saved. */
  add(): Promise<boolean>;
  remove(uri: string): void;
}

/** The chosen appearance and how to change it (Settings → Appearance); stored on the phone. */
export interface AppearanceControl {
  appearance: Appearance;
  set(change: Partial<Appearance>): void;
  photos?: PhotoActions; // absent where photos can't be kept (tests, web)
}

export const AppearanceContext = createContext<AppearanceControl>({ appearance: DEFAULT_APPEARANCE, set: () => {} });

export function useAppearance(): AppearanceControl {
  return useContext(AppearanceContext);
}

/**
 * How glass draws, chosen once by the composition root and again when battery saver changes:
 * - 'shader': Android 13+, the AGSL lens over a blurred backdrop;
 * - 'blur': Android 12, blur and saturation only;
 * - 'flat': older Android, battery saver, tests and web (?blur=0 shows the fallback honestly).
 */
export type GlassMode = 'shader' | 'blur' | 'flat';

/** The native glass view's props (adapters/glass/android): sizes in dp, colours as straight RGBA 0..1. */
export interface NativeGlassProps {
  backdrop: number; // the React tag of the view behind
  mode: Exclude<GlassMode, 'flat'>;
  cornerRadius: number;
  blur: number;
  refraction: number;
  bezel: number;
  dispersion: number;
  saturation: number;
  lift: number;
  specular: number;
  rimWidth: number;
  tint: number[];
  base: number[]; // opaque: the app's background under the frost
  style?: object;
  pointerEvents?: 'none';
}

export interface GlassSettings {
  mode: GlassMode;
  /** The native view that draws real glass; null where there's none (then every surface is flat). */
  View: ComponentType<NativeGlassProps> | null;
  /** Android's "Remove animations": motion jumps to its end state. */
  reduceMotion: boolean;
  /** The colour scheme glass sits in (its rim): 'dark' when absent (the app is dark today). */
  scheme?: Scheme;
}

export const SHADER_MIN_SDK = 33; // RenderEffect.createRuntimeShaderEffect: Android 13
export const BLUR_MIN_SDK = 31; // RenderEffect blur: Android 12

/** The glass the device can afford: none without the native view, in battery saver or before Android 12. */
export function glassMode(sdkInt: number | null, powerSave: boolean): GlassMode {
  if (sdkInt === null || powerSave) return 'flat';
  if (sdkInt >= SHADER_MIN_SDK) return 'shader';
  return sdkInt >= BLUR_MIN_SDK ? 'blur' : 'flat';
}

export const GlassContext = createContext<GlassSettings>({ mode: 'flat', View: null, reduceMotion: false });

export function useGlass(): GlassSettings {
  return useContext(GlassContext);
}

/** Space the floating header (top) and the gesture area (bottom) take from a screen's content (set by the shell). */
export interface ChromeInsets {
  top: number;
  bottom: number;
}

export const ChromeContext = createContext<ChromeInsets>({ top: 0, bottom: 0 });

export function useChrome(): ChromeInsets {
  return useContext(ChromeContext);
}
