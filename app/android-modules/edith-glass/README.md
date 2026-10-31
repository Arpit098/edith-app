# edith-glass

What the module provides: Liquid Glass for the app's chrome (PLAN.md §4.11), battery-saver state, and frame-time measurement.

- **`EdithGlassView`**: glass over a backdrop view, which is found by its React tag (`backdrop` prop).
  - **Android 13+:** blur, then the AGSL lens in `GlassShader.kt`: refraction at the rim, chromatic
    dispersion, saturation, tint and a specular highlight.
  - **Android 12:** blur plus saturation, with the tint drawn on top.
  - **Below 12, or in battery saver:** JS doesn't mount the view, and the flat translucent styling shows.
  - The backdrop is recorded as a display list into a `RenderNode`, not copied to a bitmap.
  - It redraws only when the backdrop has pending drawing or the glass moves. A pre-draw listener
    checks this, and nothing runs on a timer.
  - Redraws for a changed backdrop are capped at about 30 a second, with the last one always drawn.
    Glass that moves itself redraws at once.
  - Each view compiles the AGSL shader once and then only updates its uniforms. A detached view
    gives its compiled shader back to a small pool (at most 4), and a new view takes one from there,
    so glass that mounts again and again (the navigation menu's sheet) never recompiles it.
- **`sdkInt`, `isPowerSaveMode()`, event `onPowerSaveChanged {on}`:** the `PowerManager` broadcast,
  registered only while JS listens.
- **`startFrameStats()` / `stopFrameStats()`:** `FrameMetrics` for the window, returning frames,
  p50/p95/p99/max in ms, janky frames (past the frame deadline) and the refresh rate.

It's exposed to JS through `src/adapters/glass/android` (the `DevicePower` and `FrameMeter` ports)
and `src/ui/Glass.tsx`.

## Credits

The shader and the capture code are our own. No third-party shader code is used. If one is ever
adapted, its licence (it must be MIT or Apache-2.0) and source go here.
