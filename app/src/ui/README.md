# Shared UI

Presentational components used by several features (buttons, chat bubble, diff view, tool-call card). No feature logic or API calls here.

- **Glass** (`Glass.tsx`): a Liquid Glass surface. `rim` swaps the hairline edge for the specular
  rim (`Rim.tsx`): a gradient stroke bright at the top-left and bottom-right, an inner highlight and
  a faint inner shadow, drawn as SVG so it's the same on real glass, blur only and the flat
  fallback, in the scheme's colours (`rims` in the theme, `GlassSettings.scheme`, dark by default).
- **Popup legibility** (the `panel` level's `legibility` token): the rim is real Liquid Glass (light
  tint, strong lens) and the content area gets a second, harder-blurred glass view plus a feathered
  scrim, so popup text keeps WCAG 4.5:1 over any backdrop in every mode. The check is
  `core/theme/__tests__/contrast.test.ts` (helpers in `core/theme/contrast.ts`); popup text uses
  `colors.text` or `colors.textSecondary` only, at full opacity, with `legibleText`'s soft shadow.
- **GrowSheet** (`motion.tsx`): a sheet that grows out of its trigger and shrinks back, unmounted once closed.
- **The rim is thin** (Arpit, 31 Oct): about a hairline (0.5 dp) and about as bright as the thin
  glass edge, still lit at the top-left and bottom-right, with a 1 dp inner glow.
- **ThinkingBubble** (`ThinkingBubble.tsx`, geometry in `bubbleShape.ts`): the header's orb in the
  icon's colours (`bubble` tokens). Its wobbling rim and turning bands are SVG paths computed in
  worklets and fed as animated props: one UI-thread loop, no React renders per frame. Idle, or with
  "Remove animations" on, it's a still frame.
- **SwipeToReply** (`SwipeToReply.tsx`, maths in `swipe.ts`): drag a row right to reply. A
  PanResponder (no gesture library) claims only clearly sideways drags; the row follows a shared
  value and springs back on the UI thread. No haptic: `Vibration` needs the VIBRATE permission,
  which the app blocks (a native follow-up).
