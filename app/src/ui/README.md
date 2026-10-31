# Shared UI

Presentational components used by several features (buttons, chat bubble, diff view, tool-call card). No feature logic or API calls here.

- **Glass** (`Glass.tsx`): a Liquid Glass surface. `rim` swaps the hairline edge for the specular
  rim (`Rim.tsx`): a gradient stroke bright at the top-left and bottom-right, an inner highlight and
  a faint inner shadow, drawn as SVG so it's the same on real glass, blur only and the flat
  fallback, in the scheme's colours (`rims` in the theme, `GlassSettings.scheme`, dark by default).
- **Popups are clear glass** (Arpit, 31 Oct; the `panel` level): the menus and the status card have
  no background of their own. What's behind shows through with a light blur (14 dp), a very faint
  tint and a thin bend at the edge, like iOS 26 menus. Labels and icons stay readable by themselves:
  a dark soft halo (`legibleText`, `Icon halo`), weight 500 and up, full-opacity `colors.text` or
  `colors.textSecondary`. The trade-off: on real glass no WCAG ratio is promised (over a white photo
  the halo does the work); only the flat fallback keeps a tinted pane, at 4.5:1. The check is
  `core/theme/__tests__/contrast.test.ts`.
- **The bend is thin** (Arpit, 31 Oct): the lens bends the backdrop in a 6–8 dp band at the edge
  (`bezel`, was 14–22 dp), pulling in 4–5 dp at the very edge (`refraction`).
- **GrowSheet** (`motion.tsx`): a sheet that grows out of its trigger and shrinks back, unmounted once closed.
- **The rim is thin** (Arpit, 31 Oct): about a hairline (0.5 dp) and about as bright as the thin
  glass edge, still lit at the top-left and bottom-right, with a 1 dp inner glow.
- **ThinkingBubble** (`ThinkingBubble.tsx`, motion in `orbShape.ts`): the header's thinking orb, a
  Siri-style orb in the icon's colours (`orb` tokens; Arpit, 31 Oct: "like the new Siri bubble, which
  is not transparent from inside"). An opaque sphere (deep indigo edge, the logo's blue middle) filled
  with soft colour blobs (violet, blue, lavender, icy cyan; radial gradients fading out, since SVG blur
  isn't dependable on Android) and three ribbons of light, under a shaded edge, a glossy highlight at
  the top-left, a soft-lit rim and a gentle outer glow. While EDITH works the blobs drift, the ribbons
  swirl and fold, and the glow and rim breathe: animated props computed in worklets from one phase,
  one UI-thread loop, no React renders per frame. Idle, or with "Remove animations" on, it's a still
  frame of the same orb.
- **SwipeToReply** (`SwipeToReply.tsx`, maths in `swipe.ts`): drag a row right to reply. A
  PanResponder (no gesture library) claims only clearly sideways drags; the row follows a shared
  value and springs back on the UI thread. No haptic: `Vibration` needs the VIBRATE permission,
  which the app blocks (a native follow-up).
