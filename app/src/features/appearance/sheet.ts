// Appearance's tools and its bottom sheet, as data: which tool is open and where the sheet rests.
// The sheet has two snap points: "collapsed" (only the toolbar shows, the preview is whole) and
// "half" (the tool's controls over the lower half; the preview's chat stays in view above). Pure, so
// the toolbar → sheet → collapse/expand/back/drag rules are tested without rendering.

export type ToolId = 'theme' | 'background' | 'photo' | 'bubbles' | 'accent' | 'glass' | 'reset';

export interface Tool {
  id: ToolId;
  label: string;
  icon: string; // MaterialCommunityIcons
  hint: string; // one line under the sheet's title (and the tool's TalkBack hint)
}

/** Most used first. */
export const TOOLS: readonly Tool[] = [
  { id: 'theme', label: 'Theme', icon: 'palette-outline', hint: 'A whole look at once: background, accent and bubbles.' },
  { id: 'background', label: 'Background', icon: 'image-filter-hdr', hint: 'The theme’s backdrops, gradients and patterns, or your own gradient.' },
  { id: 'photo', label: 'Photo', icon: 'image-outline', hint: 'Your own picture behind the chat: blur, dim and what stays in view.' },
  { id: 'bubbles', label: 'Bubbles', icon: 'chat-outline', hint: 'Your messages and EDITH’s, each a colour or a gradient.' },
  { id: 'accent', label: 'Accent', icon: 'format-color-fill', hint: 'Buttons, chips, links and the send button.' },
  { id: 'glass', label: 'Glass', icon: 'blur', hint: 'How much the header and composer blur and bend what’s behind.' },
  { id: 'reset', label: 'Reset', icon: 'restore', hint: 'Everything back to the default look.' },
];

export const toolOf = (id: ToolId): Tool => TOOLS.find((t) => t.id === id)!;

export type Snap = 'collapsed' | 'half';

export interface SheetState {
  tool: ToolId | null; // the tool whose controls the sheet holds (kept while collapsed, for expand)
  snap: Snap;
}

export const initialSheet: SheetState = { tool: null, snap: 'collapsed' };

export type SheetAction =
  | { type: 'pick'; tool: ToolId } // a toolbar tap
  | { type: 'collapse' } // the chevron-down
  | { type: 'expand' } // the chevron-up
  | { type: 'back' } // Android back (only acted on while open: see backHandled)
  | { type: 'settle'; progress: number; velocity: number }; // a drag let go: progress 0 (collapsed) .. 1 (half)

/** Past this speed (sheet heights per second) a drag is a fling: it goes the way it was thrown. */
export const FLING = 0.8;

/** Where a released drag rests: a fling goes its way, otherwise the nearer snap point. */
export function snapFor(progress: number, velocity: number): Snap {
  if (velocity >= FLING) return 'half';
  if (velocity <= -FLING) return 'collapsed';
  return progress >= 0.5 ? 'half' : 'collapsed';
}

export function sheetReducer(s: SheetState, a: SheetAction): SheetState {
  switch (a.type) {
    case 'pick':
      // The open tool's own button closes it again; any other opens (or switches to) that tool.
      return s.tool === a.tool && s.snap === 'half' ? { ...s, snap: 'collapsed' } : { tool: a.tool, snap: 'half' };
    case 'collapse':
    case 'back':
      return s.snap === 'collapsed' ? s : { ...s, snap: 'collapsed' };
    case 'expand':
      return { tool: s.tool ?? TOOLS[0]!.id, snap: 'half' };
    case 'settle': {
      const snap = snapFor(a.progress, a.velocity);
      return snap === 'half' ? { tool: s.tool ?? TOOLS[0]!.id, snap } : snap === s.snap ? s : { ...s, snap };
    }
  }
}

/** Whether Android back closes the sheet (true) or leaves the page (false). */
export const backHandled = (s: SheetState): boolean => s.snap === 'half';

/** What TalkBack hears when the sheet changes. */
export function sheetAnnouncement(s: SheetState): string {
  return s.snap === 'half' && s.tool ? `${toolOf(s.tool).label} controls open` : 'Controls closed';
}
