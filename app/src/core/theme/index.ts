// The app's theme: tokens plus the glass setting the shell decides at runtime.

import { createContext, useContext, type ComponentType } from 'react';

import type { Scheme } from './tokens';

export * from './tokens';

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
