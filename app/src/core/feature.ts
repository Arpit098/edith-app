// Feature contract and registry. Each folder in src/features/ exports one FeatureModule.
// Features may import from core/, common/ and ui/, never from another feature or from adapters/.

import type { ComponentType } from 'react';
import type { Api } from './api';
import type { Connection } from './connection';
import type { EventBus } from './events';
import type { Ports } from './ports';

export interface FeatureContext {
  bus: EventBus;
  ports: Ports;
  api: Api; // typed App API over ports.transport
  connection: Connection; // read its store for the link state; features never open a stream
}

export interface Screen {
  name: string; // unique route name, e.g. "sessions"
  title: string;
  component: ComponentType;
  tab?: boolean; // a main screen: listed in the navigation menu (keep it to a handful)
  icon?: string; // tab icon: a MaterialCommunityIcons name, e.g. "history"
}

/** The groups of the Settings list, in the order they show (shell/settingsGroups.ts has their titles). */
export type SettingsGroup = 'connection' | 'notifications' | 'voice' | 'app' | 'about' | 'more';

/** A setting that is just on or off, switched right in the Settings list (its row still opens the page). */
export interface SettingsToggle {
  on: boolean;
  set(on: boolean): void;
  disabled?: boolean;
  /** Dim text before the switch while it matters, e.g. "Every 15 min". */
  detail?: string | null;
}

/**
 * A row in Settings that opens `component` on its own page. Only `title` and `component` are required:
 * a section without the rest goes under "More", with a generic icon and no summary line.
 */
export interface SettingsSection {
  title: string; // unique: it is the page's key and its header
  component: ComponentType;
  group?: SettingsGroup;
  icon?: string; // an outline MaterialCommunityIcons name, e.g. "bell-outline"
  order?: number; // within the group, lowest first (default 100; ties by title)
  /** A React hook, called while the row renders: one short line of live state, e.g. "On · Instant". */
  summary?: () => string | null;
  /** A React hook: the row's inline switch, or null for none right now (e.g. not on this phone). */
  toggle?: () => SettingsToggle | null;
  /** A React hook: a few words for the card at the top of Settings, after the link state ("Interseqt active"). */
  badge?: () => string | null;
  /**
   * "card" (default): the page scrolls; its content draws its own cards (ui/SettingsRows). "full": the content fills the page
   * under its back header and lays itself out (an editor); it may take Android back first (core/pageBack).
   */
  layout?: 'card' | 'full';
}

/** A tile in the Tools launcher grid. Most features are tools; the navigation menu lists only a handful of main screens. */
export interface Tool {
  title: string; // tile label, e.g. "Reminders"
  icon: string; // a MaterialCommunityIcons name, e.g. "alarm"
  screen: string; // the Screen.name it opens; must be one of this feature's screens
}

/**
 * Where a panel shows. "banner": above every screen (e.g. pending approvals). "header": the
 * header's left side (the live session's status chip); the first one loaded is shown, and the
 * shell's connection dot only when there's none.
 */
export type PanelSlot = 'banner' | 'header';

/** What the shell hands a panel: where its popup goes (just under the header) and what its glass bends. */
export interface PanelProps {
  top: number;
  backdrop: number | null;
}

export interface Panel {
  slot: PanelSlot;
  component: ComponentType<PanelProps>;
  /** Drawn over the screen (under the navigation menu): the panel's popup, e.g. the status card. */
  overlay?: ComponentType<PanelProps>;
}

export interface FeatureModule {
  id: string; // matches the folder name
  screens?: Screen[];
  settings?: SettingsSection[];
  tool?: Tool; // add a tile to the Tools grid instead of (or as well as) a bottom tab
  panels?: Panel[];
  /** Called once at startup. Subscribe to events here; return a cleanup function if needed. */
  setup?: (ctx: FeatureContext) => void | (() => void);
}

export interface LoadedFeatures {
  screens: Screen[];
  settings: SettingsSection[];
  tools: Tool[];
  panels: Panel[];
  failed: Record<string, string>;
  cleanup: () => void;
}

/** Loads features one by one; a failing feature is skipped (and reported) without affecting the rest. */
export function loadFeatures(features: FeatureModule[], ctx: FeatureContext): LoadedFeatures {
  const out: LoadedFeatures = { screens: [], settings: [], tools: [], panels: [], failed: {}, cleanup: () => {} };
  const cleanups: (() => void)[] = [];
  const names = new Set<string>();
  const ids = new Set<string>();
  const toolScreens = new Set<string>();
  for (const f of features) {
    try {
      if (ids.has(f.id)) throw new Error(`feature "${f.id}" already loaded`);
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
      ids.add(f.id);
      for (const s of f.screens ?? []) names.add(s.name);
      out.screens.push(...(f.screens ?? []));
      out.settings.push(...(f.settings ?? []));
      out.panels.push(...(f.panels ?? []));
      if (f.tool) {
        toolScreens.add(f.tool.screen);
        out.tools.push(f.tool);
      }
    } catch (e) {
      console.warn(`[edith] feature ${f.id} failed to load`, e);
      out.failed[f.id] = String(e);
    }
  }
  out.cleanup = () => {
    for (const c of cleanups.reverse()) {
      try {
        c();
      } catch (e) {
        console.warn('[edith] feature cleanup failed', e);
      }
    }
  };
  return out;
}
