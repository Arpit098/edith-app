// Feature contract and registry. Each folder in src/features/ exports one FeatureModule.
// Features may import from core/, common/ and ui/, never from another feature or from adapters/.

import type { ComponentType } from 'react';
import type { EventBus } from './events';
import type { Ports } from './ports';

export interface FeatureContext {
  bus: EventBus;
  ports: Ports;
}

export interface Screen {
  name: string; // unique route name, e.g. "sessions"
  title: string;
  component: ComponentType;
  tab?: boolean; // show in the bottom tab bar
}

export interface SettingsSection {
  title: string;
  component: ComponentType;
}

/** A tile in the Tools launcher grid. Most features are tools; the bottom tab bar fits only ~5. */
export interface Tool {
  title: string; // tile label, e.g. "Reminders"
  icon: string; // icon name (the icon set is picked in Phase 2)
  screen: string; // the Screen.name it opens; must be one of this feature's screens
}

export interface FeatureModule {
  id: string; // matches the folder name
  screens?: Screen[];
  settings?: SettingsSection[];
  tool?: Tool; // add a tile to the Tools grid instead of (or as well as) a bottom tab
  /** Called once at startup. Subscribe to events here; return a cleanup function if needed. */
  setup?: (ctx: FeatureContext) => void | (() => void);
}

export interface LoadedFeatures {
  screens: Screen[];
  settings: SettingsSection[];
  tools: Tool[];
  failed: Record<string, string>;
  cleanup: () => void;
}

/** Loads features one by one; a failing feature is skipped (and reported) without affecting the rest. */
export function loadFeatures(features: FeatureModule[], ctx: FeatureContext): LoadedFeatures {
  const out: LoadedFeatures = { screens: [], settings: [], tools: [], failed: {}, cleanup: () => {} };
  const cleanups: (() => void)[] = [];
  const names = new Set<string>();
  const toolScreens = new Set<string>();
  for (const f of features) {
    try {
      for (const s of f.screens ?? []) {
        if (names.has(s.name)) throw new Error(`screen "${s.name}" already registered`);
      }
      if (f.tool) {
        const screen = f.tool.screen;
        if (!(f.screens ?? []).some((s) => s.name === screen)) {
          throw new Error(`tool "${f.tool.title}" opens screen "${screen}", which this feature doesn't have`);
        }
        if (toolScreens.has(screen)) throw new Error(`a tool for screen "${screen}" is already registered`);
      }
      const cleanup = f.setup?.(ctx);
      if (cleanup) cleanups.push(cleanup);
      for (const s of f.screens ?? []) names.add(s.name);
      out.screens.push(...(f.screens ?? []));
      out.settings.push(...(f.settings ?? []));
      if (f.tool) {
        toolScreens.add(f.tool.screen);
        out.tools.push(f.tool);
      }
    } catch (e) {
      console.warn(`[edith] feature ${f.id} failed to load`, e);
      out.failed[f.id] = String(e);
    }
  }
  out.cleanup = () => cleanups.forEach((c) => c());
  return out;
}
