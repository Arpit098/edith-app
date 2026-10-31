# Shared UI

Presentational components used by several features (buttons, chat bubble, diff view, tool-call card). No feature logic or API calls here.

- **Glass** (`Glass.tsx`): a Liquid Glass surface. `rim` swaps the hairline edge for the specular
  rim (`Rim.tsx`): a gradient stroke bright at the top-left and bottom-right, an inner highlight and
  a faint inner shadow, drawn as SVG so it's the same on real glass, blur only and the flat
  fallback, in the scheme's colours (`rims` in the theme, `GlassSettings.scheme`, dark by default).
- **GrowSheet** (`motion.tsx`): a sheet that grows out of its trigger and shrinks back, unmounted once closed.
