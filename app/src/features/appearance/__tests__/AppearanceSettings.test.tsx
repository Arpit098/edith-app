// Settings → Appearance against a root like App's (the appearance store, the theme it resolves):
// taps apply at once (the preview follows; the chat's own bubbles are tested in live-session), the
// glass slider previews live while dragged and applies on release.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';
import { useMemo } from 'react';

import { createAppearanceStore, type AppearanceStore } from '../../../core/appearance';
import { useStore } from '../../../core/store';
import { AppearanceContext, GlassContext, resolveTheme, rgbaOf, SWATCHES, ThemeContext } from '../../../core/theme';
import { AppearanceSettings } from '../AppearanceSettings';
import { appearanceSummary } from '../summary';

jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache

/** The composition root's part: the stored appearance → the theme → the app. */
function Root({ appearance, children }: { appearance: AppearanceStore; children: React.ReactNode }) {
  const chosen = useStore(appearance.store, (a) => a);
  const theme = useMemo(() => resolveTheme(chosen), [chosen]);
  const control = useMemo(() => ({ appearance: chosen, set: appearance.set }), [chosen, appearance]);
  return (
    <AppearanceContext.Provider value={control}>
      <ThemeContext.Provider value={theme}>
        <GlassContext.Provider value={{ mode: 'flat', View: null, reduceMotion: true }}>{children}</GlassContext.Provider>
      </ThemeContext.Provider>
    </AppearanceContext.Provider>
  );
}

function mount(appearance: AppearanceStore): ReactTestRenderer {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <Root appearance={appearance}>
        <AppearanceSettings />
      </Root>,
    );
  });
  return r;
}

const byLabel = (r: ReactTestRenderer, label: string) => r.root.find((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function');
const tap = (r: ReactTestRenderer, label: string) => act(() => byLabel(r, label).props.onPress());
const styleOf = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style);
const previewBubble = (r: ReactTestRenderer, side: 'mine' | 'edith') => styleOf(r.root.findAll((n) => n.props.testID === `preview-${side}` && n.props.style)[0]!);
const textColour = (r: ReactTestRenderer, words: string) => StyleSheet.flatten(r.root.findAllByType(Text).find((t) => t.props.children === words)!.props.style).color;
const preview = (r: ReactTestRenderer) => r.root.find((n) => n.props.testID === 'appearance-preview').props.accessibilityLabel as string;

afterEach(() => jest.restoreAllMocks());

describe('Appearance', () => {
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
    tap(r, 'Teal for my messages');
    tap(r, 'Purple for EDITH’s messages');
    expect(a.store.get()).toMatchObject({ myBubble: 'teal', edithBubble: 'purple' });
    const t = resolveTheme(a.store.get());
    const teal = rgbaOf(SWATCHES.find((s) => s.id === 'teal')!.color);
    const mine = rgbaOf(previewBubble(r, 'mine').backgroundColor as string);
    expect(mine.slice(0, 3).map((v) => Math.round(v * 255))).toEqual(teal.slice(0, 3).map((v) => Math.round(v * 255)));
    expect(previewBubble(r, 'edith').backgroundColor).toBe(t.edith.fill);
    expect(textColour(r, 'Nice, ship it')).toBe(t.my.ink);
    tap(r, 'Theme default for my messages');
    expect(a.store.get().myBubble).toBeNull();
  });

  it('a background choice redraws the backdrop', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    tap(r, 'Dots background');
    expect(a.store.get().background).toBe('dots');
    expect(r.root.findAll((n) => n.props.testID === 'ambient-dots').length).toBeGreaterThan(0);
    expect(appearanceSummary(a.store.get())).toBe('Midnight · Dots · Glass 60%');
  });

  it('the glass slider previews while dragged and applies on release; the chat goes flat at 0%', () => {
    const a = createAppearanceStore(undefined);
    const r = mount(a);
    const slider = () => r.root.find((n) => n.props.label === 'Glass' && typeof n.props.onMove === 'function');
    act(() => slider().props.onMove(0.2));
    expect(preview(r)).toBe('Preview: Midnight, glass 20%');
    expect(a.store.get().glass).toBe(60); // the app waits for the release
    act(() => slider().props.onChange(0));
    expect(a.store.get().glass).toBe(0);
    expect(preview(r)).toBe('Preview: Midnight, glass 0%');
    // At 0% the chat's bubbles are solid (alpha 1) and have no sheen.
    const t = resolveTheme(a.store.get());
    expect(rgbaOf(t.my.fill)[3]).toBe(1);
    expect(r.root.findAll((n) => n.props.testID === 'preview-mine')[0]!.findAll((n) => Array.isArray(n.props.colors)).length).toBe(0);
    tap(r, 'Glass back to 60%');
    expect(a.store.get().glass).toBe(60);
  });
});
