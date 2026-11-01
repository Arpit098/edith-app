// Settings → Appearance against a root like App's (the appearance store, the theme it resolves):
// sections open one at a time; taps apply at once (the preview follows; the chat's own bubbles are
// tested in live-session); the builders show their draft in the preview and keep it only on Save;
// the glass slider previews live while dragged and applies on release.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { AccessibilityInfo, Alert, BackHandler, StyleSheet, Text } from 'react-native';
import { useMemo } from 'react';

import { createAppearanceStore, type AppearanceStore } from '../../../core/appearance';
import { useStore } from '../../../core/store';
import type { PickedWallpaper } from '../../../core/ports';
import {
  ACCENTS,
  AppearanceContext,
  DEFAULT_PHOTO_ADJUST,
  GlassContext,
  hexToHsv,
  MAX_CUSTOM,
  MAX_PHOTOS,
  NEW_BACKGROUND_GRADIENT,
  resolveTheme,
  rgbaOf,
  SWATCHES,
  ThemeContext,
  type GlassMode,
  type PhotoBackground,
} from '../../../core/theme';
import { AppearanceSettings } from '../AppearanceSettings';
import { appearanceSummary } from '../summary';

jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

/** The composition root's part: the stored appearance → the theme → the app. */
function Root({ appearance, reduceMotion, mode, children }: { appearance: AppearanceStore; reduceMotion: boolean; mode: GlassMode; children: React.ReactNode }) {
  const chosen = useStore(appearance.store, (a) => a);
  const theme = useMemo(() => resolveTheme(chosen), [chosen]);
  const control = useMemo(() => ({ appearance: chosen, set: appearance.set, photos: appearance.photos }), [chosen, appearance]);
  return (
    <AppearanceContext.Provider value={control}>
      <ThemeContext.Provider value={theme}>
        <GlassContext.Provider value={{ mode, View: null, reduceMotion }}>{children}</GlassContext.Provider>
      </ThemeContext.Provider>
    </AppearanceContext.Provider>
  );
}

function mount(appearance: AppearanceStore, reduceMotion = true, mode: GlassMode = 'flat'): ReactTestRenderer {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <Root appearance={appearance} reduceMotion={reduceMotion} mode={mode}>
        <AppearanceSettings />
      </Root>,
    );
  });
  return r;
}

const pressables = (r: ReactTestRenderer, label: string) => r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const byLabel = (r: ReactTestRenderer, label: string) => pressables(r, label)[0]!;
const tap = (r: ReactTestRenderer, label: string) => act(() => byLabel(r, label).props.onPress());
/** A tool's button in the toolbar ("Bubbles"), and opening its controls in the sheet. */
const tool = (r: ReactTestRenderer, title: string) => r.root.find((n) => n.props.testID === `tool-${title.toLowerCase()}` && typeof n.props.onPress === 'function');
const open = (r: ReactTestRenderer, title: string) => act(() => tool(r, title).props.onPress());
/** Bubbles: show one side's choices (the My / EDITH switch). */
const side = (r: ReactTestRenderer, who: 'My messages' | 'EDITH’s messages') => tap(r, who);
const slider = (r: ReactTestRenderer, label: string) => r.root.find((n) => n.props.label === label && typeof n.props.onChange === 'function' && n.props.value !== undefined);
const styleOf = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style);
const previewNode = (r: ReactTestRenderer, side: 'mine' | 'edith') => r.root.findAll((n) => n.props.testID === `preview-${side}` && n.props.style)[0]!;
const previewBubble = (r: ReactTestRenderer, side: 'mine' | 'edith') => styleOf(previewNode(r, side));
const previewFill = (r: ReactTestRenderer, side: 'mine' | 'edith') => previewNode(r, side).findAll((n) => n.props.testID === 'bubble-fill' && Array.isArray(n.props.colors))[0];
const textColour = (r: ReactTestRenderer, words: string) => StyleSheet.flatten(r.root.findAllByType(Text).find((t) => t.props.children === words)!.props.style).color;
const preview = (r: ReactTestRenderer) => r.root.find((n) => n.props.testID === 'appearance-preview').props.accessibilityLabel as string;
const has = (r: ReactTestRenderer, testID: string) => r.root.findAll((n) => n.props.testID === testID).length > 0;
/** The preview's own backdrop: the first Ambient inside it. */
const previewAmbient = (r: ReactTestRenderer) => r.root.find((n) => n.props.testID === 'appearance-preview').findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('ambient-') && n.props.style)[0]!.props.testID as string;

afterEach(() => jest.restoreAllMocks());

describe('Appearance', () => {
  it('the toolbar lists the tools most used first; a tool’s controls open in the sheet, one tool at a time', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    const tools = r.root.findAll((n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('tool-') && typeof n.props.onPress === 'function');
    expect(tools.map((t) => t.props.accessibilityLabel)).toEqual(['Theme', 'Background', 'Photo', 'Bubbles', 'Accent', 'Glass', 'Reset']);
    expect(tools.every((t) => t.props.accessibilityRole === 'button')).toBe(true);
    expect(tools[0]!.props.accessibilityHint).toBe('A whole look at once: background, accent and bubbles.'); // the tool's own hint
    expect(pressables(r, 'Ocean theme')).toHaveLength(0); // the sheet starts closed: the whole preview shows
    open(r, 'Theme');
    expect(tool(r, 'Theme').props.accessibilityState).toEqual({ expanded: true });
    expect(pressables(r, 'Ocean theme')).toHaveLength(1);
    open(r, 'Background');
    expect(tool(r, 'Theme').props.accessibilityState).toEqual({ expanded: false });
    expect(pressables(r, 'Ocean theme')).toHaveLength(0);
    expect(pressables(r, 'Dots background')).toHaveLength(1);
    open(r, 'Background'); // its own button closes it again
    expect(tool(r, 'Background').props.accessibilityState).toEqual({ expanded: false });
  });

  it('a theme applies at once: the preview, the chat and the summary follow', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    expect(preview(r)).toBe('Preview: Midnight, glass 60%');
    open(r, 'Theme');
    expect(byLabel(r, 'Midnight theme').props.accessibilityState).toEqual({ selected: true });
    tap(r, 'Ocean theme');
    expect(a.store.get().theme).toBe('ocean');
    expect(preview(r)).toBe('Preview: Ocean, glass 60%');
    expect(byLabel(r, 'Ocean theme').props.accessibilityState).toEqual({ selected: true });
    const ocean = resolveTheme(a.store.get());
    expect(previewBubble(r, 'mine').backgroundColor).toBe(ocean.my.fill); // the accent's bubble, Ocean's accent
    expect(appearanceSummary(a.store.get())).toBe('Ocean · Glass 60%');
  });

  it('each side takes its own colour, with readable ink, in the preview and the chat', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    open(r, 'Bubbles');
    tap(r, 'Teal for my messages');
    expect(pressables(r, 'Purple for EDITH’s messages')).toHaveLength(0); // one side at a time
    side(r, 'EDITH’s messages');
    tap(r, 'Purple for EDITH’s messages');
    expect(a.store.get()).toMatchObject({ myBubble: 'teal', edithBubble: 'purple' });
    const t = resolveTheme(a.store.get());
    const teal = rgbaOf(SWATCHES.find((s) => s.id === 'teal')!.color);
    const mine = rgbaOf(previewBubble(r, 'mine').backgroundColor as string);
    expect(mine.slice(0, 3).map((v) => Math.round(v * 255))).toEqual(teal.slice(0, 3).map((v) => Math.round(v * 255)));
    expect(previewBubble(r, 'edith').backgroundColor).toBe(t.edith.fill);
    expect(textColour(r, 'Nice, ship it')).toBe(t.my.ink);
    side(r, 'My messages');
    tap(r, 'Theme default for my messages');
    expect(a.store.get().myBubble).toBeNull();
  });

  it('a gradient bubble draws its stops in the preview, its ink readable', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    open(r, 'Bubbles');
    tap(r, 'Sunset gradient for my messages');
    expect(a.store.get().myBubble).toBe('grad-sunset');
    const t = resolveTheme(a.store.get());
    expect(previewBubble(r, 'mine').backgroundColor).toBe('transparent'); // the fill draws the tint
    expect(previewFill(r, 'mine')!.props.colors).toEqual(t.my.gradient!.colors);
    expect(textColour(r, 'Nice, ship it')).toBe(t.my.ink);
    expect(previewFill(r, 'edith')).toBeUndefined(); // EDITH's is still one colour: no extra view
  });

  it('"Custom…" for a bubble shows the draft live and keeps it only on Save', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    open(r, 'Bubbles');
    side(r, 'EDITH’s messages');
    tap(r, 'Custom gradient for EDITH’s messages');
    expect(has(r, 'builder-bubble')).toBe(true);
    expect(pressables(r, 'Add a colour stop')).toHaveLength(0); // a bubble has 2 stops
    expect(pressables(r, 'Radial gradient')).toHaveLength(0); // and is linear
    tap(r, 'Red for stop 1');
    tap(r, 'Direction Right');
    const draft = previewFill(r, 'edith')!.props;
    expect(draft.start).toEqual({ x: 0, y: 0.5 });
    expect(a.store.get().edithBubble).toBeNull(); // not kept yet
    tap(r, 'Cancel');
    expect(previewFill(r, 'edith')).toBeUndefined();
    tap(r, 'Custom gradient for EDITH’s messages');
    tap(r, 'Red for stop 1');
    tap(r, 'Save gradient for edith’s messages');
    expect(a.store.get()).toMatchObject({ edithBubble: 'custom', edithGradient: { stops: ['#FF4E50', '#9B7CF0'], angle: 135 } });
    expect(previewFill(r, 'edith')).toBeDefined();
    expect(pressables(r, 'Your gradient for EDITH’s messages')[0]!.props.accessibilityState).toEqual({ selected: true });
    tap(r, 'Blue for EDITH’s messages'); // another choice: the gradient is kept to come back to
    expect(a.store.get()).toMatchObject({ edithBubble: 'blue', edithGradient: { stops: ['#FF4E50', '#9B7CF0'] } });
  });

  it('a background choice redraws the backdrop, gradients included', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    open(r, 'Background');
    tap(r, 'Dots background');
    expect(a.store.get().background).toBe('dots');
    expect(previewAmbient(r)).toBe('ambient-dots');
    expect(appearanceSummary(a.store.get())).toBe('Midnight · Dots · Glass 60%');
    tap(r, 'Lavender mist background');
    expect(previewAmbient(r)).toBe('ambient-lavender');
    expect(r.root.find((n) => n.props.testID === 'appearance-preview').findAll((n) => n.props.testID === 'ambient-radial').length).toBeGreaterThan(0);
  });

  it('a drifting gradient drifts in the preview, and holds still with "Remove animations"', () => {
    const a = createAppearanceStore(undefined);
    a.set({ background: 'aurora-drift' });
    const still = mount(a, true);
    expect(has(still, 'ambient-drift')).toBe(false);
    const moving = mount(a, false);
    const preview = moving.root.find((n) => n.props.testID === 'appearance-preview');
    expect(preview.findAll((n) => n.props.testID === 'ambient-drift').length).toBeGreaterThan(0);
    open(moving, 'Background');
    // The thumbnails never move, only the backdrop itself.
    const tile = byLabel(moving, 'Aurora drift background');
    expect(tile.findAll((n) => n.props.testID === 'ambient-drift')).toHaveLength(0);
    act(() => moving.unmount()); // stops the loop
  });

  it('drift pauses while real glass is drawn (every pane would re-blur each frame), and resumes at 0% glass', () => {
    const a = createAppearanceStore(undefined);
    a.set({ background: 'aurora-drift' });
    const glassy = mount(a, false, 'shader');
    expect(has(glassy, 'ambient-drift')).toBe(false); // still frame
    expect(has(glassy, 'ambient-aurora-drift')).toBe(true);
    act(() => glassy.unmount());
    a.set({ glass: 0 });
    const flat = mount(a, false, 'shader');
    expect(has(flat, 'ambient-drift')).toBe(true);
    act(() => flat.unmount());
  });

  it('"Custom…" builds a background: stops, type, intensity, live in the preview, kept on Save, then edited and deleted', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    open(r, 'Background');
    tap(r, 'New custom gradient');
    expect(has(r, 'builder-background')).toBe(true);
    expect(previewAmbient(r)).toBe('ambient-custom-draft'); // the draft, shown at once
    tap(r, 'Add a colour stop');
    tap(r, 'Mint for stop 3');
    tap(r, 'Radial gradient');
    act(() => slider(r, 'Intensity').props.onChange(0.4));
    tap(r, 'Direction Up left');
    expect(a.store.get().customGradients).toEqual([]); // nothing kept yet
    tap(r, 'Save new gradient');
    const saved = a.store.get();
    expect(saved.customGradients).toEqual([{ id: 'custom-1', stops: ['#9B7CF0', '#2E8BC0', '#3EECAC'], angle: 315, kind: 'radial', intensity: 40 }]);
    expect(saved.background).toBe('custom-1');
    expect(previewAmbient(r)).toBe('ambient-custom-1');
    expect(appearanceSummary(saved)).toBe('Midnight · Custom 1 · Glass 60%');
    tap(r, 'Edit Custom 1');
    tap(r, 'Stop 3 of 3');
    tap(r, 'Remove stop 3');
    tap(r, 'Save edit gradient');
    expect(a.store.get().customGradients[0]!.stops).toEqual(['#9B7CF0', '#2E8BC0']);
    // Delete asks first: cancelling keeps it, confirming removes it (and the background falls back).
    const ask = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    tap(r, 'Edit Custom 1');
    tap(r, 'Delete edit gradient');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]![0]).toBe('Delete Custom 1?');
    const buttons = ask.mock.calls[0]![2]!;
    act(() => buttons.find((b) => b.style === 'cancel')!.onPress?.());
    expect(a.store.get().customGradients).toHaveLength(1);
    act(() => buttons.find((b) => b.style === 'destructive')!.onPress!());
    expect(a.store.get()).toMatchObject({ customGradients: [], background: 'glow' });
    expect(has(r, 'builder-background')).toBe(false);
  });

  it('the builder’s sliders move the strip and the preview while dragged, and a stop keeps its hue through brightness 0', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    open(r, 'Background');
    tap(r, 'New custom gradient');
    const strip = () => r.root.find((n) => n.props.testID === 'builder-background').findAll((n) => Array.isArray(n.props.colors) && n.props.start)[0]!.props;
    act(() => slider(r, 'Angle').props.onMove(90 / 359)); // dragging, not released
    expect(strip().start).toEqual({ x: 0, y: 0.5 });
    const previewLayer = () => r.root.find((n) => n.props.testID === 'appearance-preview').findAll((n) => Array.isArray(n.props.colors) && n.props.start)[0]!.props;
    expect(previewLayer().start).toEqual({ x: 0, y: 0.5 });
    act(() => slider(r, 'Intensity').props.onMove(0.2));
    expect(previewLayer().colors).not.toEqual(resolveTheme({ ...a.store.get(), customGradients: [{ id: 'x', ...NEW_BACKGROUND_GRADIENT }], background: 'x' }).background.layers[0]!.colors);
    // Hue: pick 200°, brightness down to 0 (black) and back up: still 200°.
    act(() => slider(r, 'Hue, stop 1').props.onMove(200 / 360));
    act(() => slider(r, 'Brightness, stop 1').props.onChange(0));
    expect(strip().colors[0]).toBe('#000000');
    act(() => slider(r, 'Brightness, stop 1').props.onChange(1));
    expect(hexToHsv(strip().colors[0]).h).toBe(200);
    expect(a.store.get().customGradients).toEqual([]); // all still a draft
    // TalkBack hears each slider once: only the slider itself carries its name.
    const named = r.root.findAll((n) => n.props.accessibilityLabel === 'Intensity' && typeof n.type === 'string');
    expect(named.map((n) => n.props.accessibilityRole)).toEqual(['adjustable']);
  });

  it(`keeps at most ${MAX_CUSTOM} custom backgrounds`, () => {
    const a = createAppearanceStore(undefined);
    a.set({ customGradients: Array.from({ length: MAX_CUSTOM }, (_, i) => ({ id: `custom-${i + 1}`, stops: ['#FF0000', '#0000FF'], angle: 0, kind: 'linear' as const, intensity: 50 })) });
    const r = mount(a);
    open(r, 'Background');
    expect(byLabel(r, 'New custom gradient').props.disabled).toBe(true);
    expect(pressables(r, 'Custom 6 background')).toHaveLength(1);
  });

  it('an accent overrides the theme’s, and "Theme’s accent" brings it back', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    open(r, 'Accent');
    tap(r, 'Pink accent');
    expect(a.store.get().accent).toBe('pink');
    const t = resolveTheme(a.store.get());
    expect(t.accent).toBe(ACCENTS.find((x) => x.id === 'pink')!.color);
    expect(previewBubble(r, 'mine').backgroundColor).toBe(t.my.fill); // my default bubble follows the accent
    tap(r, 'Theme’s accent');
    expect(a.store.get().accent).toBeNull();
  });

  it('the glass slider previews while dragged and applies on release; the chat goes flat at 0%', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    open(r, 'Glass');
    const glass = () => r.root.find((n) => n.props.label === 'Glass' && typeof n.props.onMove === 'function');
    act(() => glass().props.onMove(0.2));
    expect(preview(r)).toBe('Preview: Midnight, glass 20%');
    expect(a.store.get().glass).toBe(60); // the app waits for the release
    act(() => glass().props.onChange(0));
    expect(a.store.get().glass).toBe(0);
    expect(preview(r)).toBe('Preview: Midnight, glass 0%');
    // At 0% the chat's bubbles are solid (alpha 1).
    const t = resolveTheme(a.store.get());
    expect(rgbaOf(t.my.fill)[3]).toBe(1);
    expect(previewBubble(r, 'mine').backgroundColor).toBe(t.my.fill);
    tap(r, 'Glass back to 60%');
    expect(a.store.get().glass).toBe(60);
  });
});

describe('Background → your photos', () => {
  /** Wallpaper files in memory; each pick a new photo of `grid`'s colour (white unless set). */
  function wallpapers() {
    const disk = new Set<string>();
    let n = 0;
    const w = {
      grid: [[1, 1, 1]] as [number, number, number][],
      cancel: false,
      pick: jest.fn(async (): Promise<PickedWallpaper | null> => {
        if (w.cancel) return null;
        const uri = `file:///docs/wallpapers/${++n}.jpg`;
        disk.add(uri);
        return { uri, width: 1080, height: 1440, grid: w.grid };
      }),
      exists: (uri: string) => disk.has(uri),
      remove: jest.fn((uri: string) => void disk.delete(uri)),
      prune: () => {},
      disk,
    };
    return w;
  }
  const add = async (r: ReactTestRenderer) => {
    await act(async () => {
      await byLabel(r, 'Your photo: pick one from the gallery').props.onPress();
    });
  };
  /** The preview's dim layer: black at the dim drawn. */
  const previewDim = (r: ReactTestRenderer) => {
    const layer = r.root.find((n) => n.props.testID === 'appearance-preview').findAll((n) => Array.isArray(n.props.colors) && /^rgba\(0, 0, 0,/.test(n.props.colors[0]))[0]!;
    return Math.round(rgbaOf(layer.props.colors[0])[3]! * 100);
  };

  it('"Your photo…" picks from the gallery: the photo becomes the background, live, under the default dim', async () => {
    const files = wallpapers();
    files.grid = [[0.2, 0.25, 0.3]]; // a dark photo: shown as chosen
    const a = createAppearanceStore(undefined, files);
    const r = mount(a);
    open(r, 'Photo');
    await add(r);
    expect(files.pick).toHaveBeenCalledTimes(1);
    const bg = a.store.get().background as PhotoBackground;
    expect(bg).toEqual({ kind: 'photo', uri: 'file:///docs/wallpapers/1.jpg', ...DEFAULT_PHOTO_ADJUST });
    expect(previewAmbient(r)).toBe('ambient-photo');
    expect(has(r, 'ambient-photo')).toBe(true);
    expect(previewDim(r)).toBe(DEFAULT_PHOTO_ADJUST.dim);
    expect(byLabel(r, 'Photo 1 background').props.accessibilityState).toEqual({ selected: true });
    expect(appearanceSummary(a.store.get())).toBe('Midnight · Photo · Glass 60%');
    // Another background (the Background tool), then back to the photo by its tile.
    open(r, 'Background');
    tap(r, 'Dots background');
    open(r, 'Photo');
    expect(has(r, 'photo-adjust')).toBe(false);
    tap(r, 'Photo 1 background');
    expect(a.store.get().background).toMatchObject({ kind: 'photo', uri: bg.uri });
  });

  it('blur and dim preview while dragged and apply on release; focus and tint apply at once', async () => {
    const files = wallpapers();
    files.grid = [[0.1, 0.1, 0.1]];
    const a = createAppearanceStore(undefined, files);
    const r = mount(a);
    open(r, 'Photo');
    await add(r);
    act(() => slider(r, 'Dim').props.onMove(0.75)); // 60%
    expect(previewDim(r)).toBe(60);
    expect((a.store.get().background as PhotoBackground).dim).toBe(DEFAULT_PHOTO_ADJUST.dim); // the app waits
    act(() => slider(r, 'Dim').props.onChange(0.75));
    expect((a.store.get().background as PhotoBackground).dim).toBe(60);
    act(() => slider(r, 'Blur').props.onMove(0.5));
    expect((a.store.get().background as PhotoBackground).blur).toBe(DEFAULT_PHOTO_ADJUST.blur);
    act(() => slider(r, 'Blur').props.onChange(0.5));
    expect((a.store.get().background as PhotoBackground).blur).toBe(10);
    // The tile keeps its own small blur (a blur change would decode every tile again); its dim follows.
    const tilePhoto = () => byLabel(r, 'Photo 1 background').find((n) => n.props.photo && n.props.thumb).props.photo;
    expect(tilePhoto()).toMatchObject({ blur: 2, dim: 60 });
    // A 3:4 photo on a taller screen loses its sides: the choices say left, centre, right.
    expect(pressables(r, 'Keep the top in view')).toHaveLength(0);
    tap(r, 'Keep the left in view');
    tap(r, 'Tint the photo in the theme’s colour');
    expect(a.store.get().background).toMatchObject({ focus: 'start', tint: true, dim: 60, blur: 10 });
  });

  it('a bright photo is dimmed further on screen, and the page says so', async () => {
    const files = wallpapers(); // white
    const a = createAppearanceStore(undefined, files);
    const r = mount(a);
    open(r, 'Photo');
    await add(r);
    const drawn = resolveTheme(a.store.get()).background.photo!;
    expect(drawn.raised).toBe(true);
    expect(previewDim(r)).toBe(drawn.dim);
    expect(r.root.findAllByType(Text).some((t) => t.props.children === `Dimmed to ${drawn.dim}% on screen, so text stays easy to read on this photo.`)).toBe(true);
  });

  it(`keeps the ${MAX_PHOTOS} newest as tiles; removing asks first and falls back to the theme’s own`, async () => {
    const files = wallpapers();
    const a = createAppearanceStore(undefined, files);
    const r = mount(a);
    open(r, 'Photo');
    for (let i = 0; i < MAX_PHOTOS + 1; i++) await add(r);
    expect(a.store.get().photos).toHaveLength(MAX_PHOTOS);
    expect(files.remove).toHaveBeenCalledWith('file:///docs/wallpapers/1.jpg'); // the oldest's file
    expect(pressables(r, `Photo ${MAX_PHOTOS + 1} background`)).toHaveLength(0);
    const ask = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    tap(r, 'Remove this photo');
    expect(ask.mock.calls[0]![0]).toBe('Remove Photo 1?');
    const buttons = ask.mock.calls[0]![2]!;
    act(() => buttons.find((b) => b.style === 'cancel')!.onPress?.());
    expect(a.store.get().photos).toHaveLength(MAX_PHOTOS);
    act(() => buttons.find((b) => b.style === 'destructive')!.onPress!());
    expect(a.store.get().photos).toHaveLength(MAX_PHOTOS - 1);
    expect(a.store.get().background).toBe('glow');
    expect(files.disk.has('file:///docs/wallpapers/4.jpg')).toBe(false);
  });

  it('a photo that can’t be read says so; cancelling changes nothing; without a place for files there’s no tile', async () => {
    const files = wallpapers();
    const a = createAppearanceStore(undefined, files);
    const r = mount(a);
    open(r, 'Photo');
    files.cancel = true;
    await add(r);
    expect(a.store.get().background).toBe('glow');
    files.pick.mockRejectedValueOnce(new Error('decode failed'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ask = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    await add(r);
    expect(ask.mock.calls[0]![0]).toBe('Couldn’t use that photo');
    const none = mount(createAppearanceStore(undefined));
    open(none, 'Photo');
    expect(pressables(none, 'Your photo: pick one from the gallery')).toHaveLength(0);
  });
});

describe('the editor: toolbar, sheet and back', () => {
  /** BackHandler as Android runs it: the newest listener first, until one returns true. */
  function fakeBack() {
    const listeners: (() => boolean)[] = [];
    jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_e, handler) => {
      listeners.push(handler as () => boolean);
      return { remove: () => void listeners.splice(listeners.indexOf(handler as () => boolean), 1) };
    });
    return () => [...listeners].reverse().some((l) => l());
  }
  const sheetHidden = (r: ReactTestRenderer) => r.root.find((n) => n.props.testID === 'appearance-sheet' && n.props.importantForAccessibility !== undefined).props.accessibilityElementsHidden as boolean;

  it('toolbar → sheet; the chevron collapses it to the toolbar and the toggle brings the same tool back', () => {
    const r = mount(createAppearanceStore(undefined));
    expect(sheetHidden(r)).toBe(true);
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
    open(r, 'Accent');
    expect(sheetHidden(r)).toBe(false);
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'header' && n.props.children === 'Accent')).not.toHaveLength(0);
    expect(announce).toHaveBeenLastCalledWith('Accent controls open');
    tap(r, 'Close Accent controls');
    expect(sheetHidden(r)).toBe(true);
    expect(announce).toHaveBeenLastCalledWith('Controls closed');
    expect(byLabel(r, 'Show the controls').props.accessibilityState).toEqual({ expanded: false });
    tap(r, 'Show the controls');
    expect(sheetHidden(r)).toBe(false);
    expect(tool(r, 'Accent').props.accessibilityState).toEqual({ expanded: true }); // the same tool
    tap(r, 'Close the controls'); // the toolbar's toggle closes it too
    expect(sheetHidden(r)).toBe(true);
  });

  it('Android back closes the sheet first, then leaves the page', () => {
    const back = fakeBack();
    const r = mount(createAppearanceStore(undefined));
    open(r, 'Glass');
    let handled = false;
    act(() => {
      handled = back();
    });
    expect(handled).toBe(true);
    expect(sheetHidden(r)).toBe(true);
    act(() => {
      handled = back();
    });
    expect(handled).toBe(false); // the page's own back takes it: Settings leaves the page
  });

  it('a drag shows in the preview only; the store, and the app, change once on release', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    const writes = jest.fn();
    a.store.subscribe(writes);
    open(r, 'Glass');
    const glass = () => r.root.find((n) => n.props.label === 'Glass' && typeof n.props.onMove === 'function');
    act(() => glass().props.onMove(0.31)); // 30% (rounded to the step)
    act(() => glass().props.onMove(0.3)); // the same 30%
    act(() => glass().props.onMove(0.2));
    expect(preview(r)).toBe('Preview: Midnight, glass 20%');
    expect(r.root.findAllByType(Text).some((t) => [t.props.children].flat().join('') === '20%')).toBe(true); // the value label follows
    expect(writes).not.toHaveBeenCalled();
    act(() => glass().props.onChange(0.2));
    expect(writes).toHaveBeenCalledTimes(1);
    expect(a.store.get().glass).toBe(20);
    expect(preview(r)).toBe('Preview: Midnight, glass 20%');
  });

  it('the preview keeps its glass and backdrop views through a change: new props, never a remount', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a, true, 'shader');
    const frame = () => r.root.find((n) => n.props.testID === 'appearance-preview' && n.props.accessible);
    const before = frame().findAll((n) => typeof n.type === 'string').length;
    open(r, 'Glass');
    const glass = () => r.root.find((n) => n.props.label === 'Glass' && typeof n.props.onMove === 'function');
    act(() => glass().props.onMove(0.8));
    act(() => glass().props.onChange(0.8));
    open(r, 'Theme');
    tap(r, 'Ocean theme');
    expect(frame().findAll((n) => typeof n.type === 'string').length).toBe(before); // the same tree, other props
  });

  it('each tool resets to the theme default; Reset all asks first and keeps your photos and gradients', () => {
    const a = createAppearanceStore(undefined);
    a.set({ accent: 'pink', glass: 30, theme: 'ocean', myBubble: 'teal', customGradients: [{ id: 'custom-1', stops: ['#FF0000', '#0000FF'], angle: 0, kind: 'linear', intensity: 50 }], background: 'custom-1' });
    const r = mount(a);
    open(r, 'Accent');
    tap(r, 'Reset accent to the theme default');
    expect(a.store.get().accent).toBeNull();
    expect(byLabel(r, 'Reset accent to the theme default').props.disabled).toBe(true); // nothing left to reset
    open(r, 'Reset');
    expect(r.root.findAllByType(Text).some((t) => t.props.children === 'Changed from the default: theme, background, bubbles, glass.')).toBe(true);
    const ask = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    tap(r, 'Reset all');
    expect(ask.mock.calls[0]![0]).toBe('Reset the whole look?');
    const buttons = ask.mock.calls[0]![2]!;
    act(() => buttons.find((b) => b.style === 'cancel')!.onPress?.());
    expect(a.store.get().glass).toBe(30); // cancelled: nothing changed
    act(() => buttons.find((b) => b.style === 'destructive')!.onPress!());
    expect(a.store.get()).toMatchObject({ theme: 'midnight', accent: null, glass: 60, myBubble: null, edithBubble: null, background: 'glow' });
    expect(a.store.get().customGradients).toHaveLength(1); // kept, to pick again
    expect(r.root.findAllByType(Text).some((t) => t.props.children === 'Everything is at its default.')).toBe(true);
  });
});
