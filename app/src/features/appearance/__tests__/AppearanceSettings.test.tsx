// Settings → Appearance against a root like App's (the appearance store, the theme it resolves):
// sections open one at a time; taps apply at once (the preview follows; the chat's own bubbles are
// tested in live-session); the builders show their draft in the preview and keep it only on Save;
// the glass slider previews live while dragged and applies on release.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import { useMemo } from 'react';

import { createAppearanceStore, type AppearanceStore } from '../../../core/appearance';
import { useStore } from '../../../core/store';
import { ACCENTS, AppearanceContext, GlassContext, MAX_CUSTOM, resolveTheme, rgbaOf, SWATCHES, ThemeContext } from '../../../core/theme';
import { AppearanceSettings } from '../AppearanceSettings';
import { appearanceSummary } from '../summary';

jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

/** The composition root's part: the stored appearance → the theme → the app. */
function Root({ appearance, reduceMotion, children }: { appearance: AppearanceStore; reduceMotion: boolean; children: React.ReactNode }) {
  const chosen = useStore(appearance.store, (a) => a);
  const theme = useMemo(() => resolveTheme(chosen), [chosen]);
  const control = useMemo(() => ({ appearance: chosen, set: appearance.set }), [chosen, appearance]);
  return (
    <AppearanceContext.Provider value={control}>
      <ThemeContext.Provider value={theme}>
        <GlassContext.Provider value={{ mode: 'flat', View: null, reduceMotion }}>{children}</GlassContext.Provider>
      </ThemeContext.Provider>
    </AppearanceContext.Provider>
  );
}

function mount(appearance: AppearanceStore, reduceMotion = true): ReactTestRenderer {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <Root appearance={appearance} reduceMotion={reduceMotion}>
        <AppearanceSettings />
      </Root>,
    );
  });
  return r;
}

const pressables = (r: ReactTestRenderer, label: string) => r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const byLabel = (r: ReactTestRenderer, label: string) => pressables(r, label)[0]!;
const tap = (r: ReactTestRenderer, label: string) => act(() => byLabel(r, label).props.onPress());
/** Open a section by its header ("Bubbles: Default · Default"). */
const section = (r: ReactTestRenderer, title: string) => r.root.find((n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith(`${title}: `) && typeof n.props.onPress === 'function');
const open = (r: ReactTestRenderer, title: string) => act(() => section(r, title).props.onPress());
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
  it('opens one section at a time, Theme first, each header saying the current choice', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    expect(section(r, 'Theme').props.accessibilityState).toEqual({ expanded: true });
    expect(pressables(r, 'Dots background')).toHaveLength(0); // Background is closed
    expect(section(r, 'Background').props.accessibilityLabel).toBe('Background: Glow');
    expect(section(r, 'Bubbles').props.accessibilityLabel).toBe('Bubbles: Default · Default');
    expect(section(r, 'Accent').props.accessibilityLabel).toBe('Accent: Theme’s');
    open(r, 'Background');
    expect(section(r, 'Background').props.accessibilityState).toEqual({ expanded: true });
    expect(section(r, 'Theme').props.accessibilityState).toEqual({ expanded: false });
    expect(pressables(r, 'Ocean theme')).toHaveLength(0);
    expect(pressables(r, 'Dots background')).toHaveLength(1);
    open(r, 'Background');
    expect(pressables(r, 'Dots background')).toHaveLength(0); // closed again
  });

  it('a theme applies at once: the preview, the chat and the summary follow', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    expect(preview(r)).toBe('Preview: Midnight, glass 60%');
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
    tap(r, 'Purple for EDITH’s messages');
    expect(a.store.get()).toMatchObject({ myBubble: 'teal', edithBubble: 'purple' });
    const t = resolveTheme(a.store.get());
    const teal = rgbaOf(SWATCHES.find((s) => s.id === 'teal')!.color);
    const mine = rgbaOf(previewBubble(r, 'mine').backgroundColor as string);
    expect(mine.slice(0, 3).map((v) => Math.round(v * 255))).toEqual(teal.slice(0, 3).map((v) => Math.round(v * 255)));
    expect(previewBubble(r, 'edith').backgroundColor).toBe(t.edith.fill);
    expect(textColour(r, 'Nice, ship it')).toBe(t.my.ink);
    expect(section(r, 'Bubbles').props.accessibilityLabel).toBe('Bubbles: Teal · Purple');
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
    expect(section(r, 'Background').props.accessibilityLabel).toBe('Background: Lavender mist');
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
    tap(r, 'Edit Custom 1');
    tap(r, 'Delete edit gradient');
    expect(a.store.get()).toMatchObject({ customGradients: [], background: 'glow' });
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
    expect(section(r, 'Accent').props.accessibilityLabel).toBe('Accent: Pink');
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
