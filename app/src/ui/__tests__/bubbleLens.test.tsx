// The chat bubbles' liquid glass (BubbleLens): Android 13+ gets the lens (refraction, the edge
// light) over a light blur of the wallpaper; Android 12 the blur and the SVG rim; nothing at 0%,
// flat mode, without a wallpaper view or on dark ink. It scales with the glass amount, never adds
// saturation or lift (text reads as the contrast checks say), and white text stays at 4.5:1 on
// any blurred or bent mix of the wallpaper's colours. Only `liquid` rows and the preview get it.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet } from 'react-native';

import { contrast, luminance, type Rgb } from '../../core/theme/contrast';
import {
  BACKGROUNDS,
  backdropSamples,
  bubbleLens,
  bubbleLensAt,
  BUBBLE_GRADIENTS,
  DEFAULT_APPEARANCE,
  GlassContext,
  GRADIENT_BACKGROUNDS,
  INK_DARK,
  INK_LIGHT,
  PRESETS,
  radius,
  resolveTheme,
  rgbaOf,
  space,
  SWATCHES,
  ThemeContext,
  type Appearance,
  type BubbleLook,
  type GlassMode,
  type NativeGlassProps,
  type Theme,
} from '../../core/theme';
import { Preview } from '../../features/appearance/Preview';
import { ItemView } from '../../features/live-session/ItemView';
import { BubbleLens, bubbleCorners, WallpaperContext } from '../Glass';

function FakeNative(_: NativeGlassProps) {
  return null;
}

function render(node: React.ReactElement, theme: Theme, mode: GlassMode = 'shader', wallpaper: number | null = 42): ReactTestRenderer {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <ThemeContext.Provider value={theme}>
        <GlassContext.Provider value={{ mode, View: FakeNative, reduceMotion: false }}>
          <WallpaperContext.Provider value={wallpaper}>{node}</WallpaperContext.Provider>
        </GlassContext.Provider>
      </ThemeContext.Provider>,
    );
  });
  return r;
}
const native = (r: ReactTestRenderer) => r.root.findAllByType(FakeNative).map((n) => n.props as NativeGlassProps);
const at = (glass: number, a: Partial<Appearance> = {}) => resolveTheme({ ...DEFAULT_APPEARANCE, background: 'sunset', glass, ...a });

afterEach(() => jest.restoreAllMocks());

describe('the bubble lens', () => {
  const box = (r: ReactTestRenderer) => r.root.find((x) => x.props.testID === 'bubble-lens' && x.props.style);
  const sizeIt = (r: ReactTestRenderer, width: number, height: number) => act(() => box(r).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));
  const rimOf = (r: ReactTestRenderer) => r.root.findAll((x) => x.props.corners !== undefined && x.props.width !== undefined, { deep: false });

  it('Android 13+: a light blur, then the lens over the wallpaper view, in the bubble’s tint, no saturation or lift', () => {
    const t = at(60);
    const r = render(<BubbleLens look={t.my} tail="right" />, t);
    const n = native(r)[0]!;
    // The edge light is the SVG rim on the exact outline, not the shader's one-radius line.
    expect(n).toMatchObject({ backdrop: 42, mode: 'shader', cornerRadius: radius.l, blur: bubbleLens.blur, refraction: bubbleLens.refraction, bezel: bubbleLens.bezel, specular: 0, saturation: 1, lift: 0 });
    expect(n.tint).toEqual(rgbaOf(t.my.fill));
    expect(n.base).toEqual(rgbaOf(t.bg));
    // Over the bubble's whole box, its edge included (the bubble hides its border).
    expect(StyleSheet.flatten(box(r).props.style)).toMatchObject({ position: 'absolute', top: -1, left: -1, right: -1, bottom: -1 });
    sizeIt(r, 220, 44);
    expect(rimOf(r)[0]!.props).toMatchObject({ width: 220, height: 44, corners: bubbleCorners('right'), strength: t.rim });
  });

  it('Android 12: blur without the lens, the same rim for the liquid look', () => {
    const t = at(60);
    const r = render(<BubbleLens look={t.edith} tail="left" />, t, 'blur');
    expect(native(r)[0]).toMatchObject({ mode: 'blur', refraction: 0, dispersion: 0, specular: 0 });
    sizeIt(r, 300, 900);
    expect(rimOf(r)[0]!.props).toMatchObject({ width: 300, height: 900, corners: bubbleCorners('left') });
  });

  it('with a ring showing (failed, a quote’s target): the glass inside the ring, no rim over it', () => {
    const t = at(60);
    const r = render(<BubbleLens look={t.my} tail="right" inside />, t);
    expect(StyleSheet.flatten(box(r).props.style)).toMatchObject({ top: 0, left: 0, right: 0, bottom: 0 });
    expect(native(r)[0]!.cornerRadius).toBe(radius.l - 1);
    expect(rimOf(r)).toHaveLength(0);
  });

  it('nothing at 0% glass, in flat mode, without a wallpaper view, or on a bubble with dark ink', () => {
    expect(native(render(<BubbleLens look={at(0).my} tail="right" />, at(0)))).toHaveLength(0);
    expect(native(render(<BubbleLens look={at(60).my} tail="right" />, at(60), 'flat'))).toHaveLength(0);
    expect(native(render(<BubbleLens look={at(60).my} tail="right" />, at(60), 'shader', null))).toHaveLength(0);
    const dark: BubbleLook = { ...at(60).my, ink: INK_DARK };
    expect(native(render(<BubbleLens look={dark} tail="right" />, at(60)))).toHaveLength(0);
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, glass: 60 }, true).lens).toBeNull(); // reduce transparency
  });

  it('a gradient bubble’s tint is its fill’s (over the lens, reaching the rim), not the lens’s', () => {
    const t = at(60, { myBubble: BUBBLE_GRADIENTS[0]!.id });
    expect(native(render(<BubbleLens look={t.my} tail="right" />, t))[0]!.tint).toEqual([0, 0, 0, 0]);
  });

  it('scales with the glass meter: grows to the tokens at 60%, a little more at 100% (blur 12 dp at most), thin edge kept', () => {
    expect(bubbleLensAt(0)).toBeNull();
    expect(bubbleLensAt(60)).toEqual(bubbleLens);
    const low = bubbleLensAt(15)!;
    const high = bubbleLensAt(100)!;
    expect(low.refraction).toBeLessThan(bubbleLens.refraction);
    expect(high.refraction).toBeGreaterThan(bubbleLens.refraction);
    expect(high.blur).toBeLessThanOrEqual(12);
    expect([low.bezel, high.bezel, low.rimWidth, high.rimWidth]).toEqual([bubbleLens.bezel, bubbleLens.bezel, bubbleLens.rimWidth, bubbleLens.rimWidth]);
    // The edge light stays inside the bubble's padding, away from the text.
    expect(bubbleLens.rimWidth).toBeLessThan(Math.min(space.m, space.s + 2));
  });
});

describe('text on liquid bubbles', () => {
  it('every see-through bubble has white ink, so the lens applies wherever a bubble is translucent', () => {
    const dark: string[] = [];
    for (const p of PRESETS)
      for (const b of [...BACKGROUNDS.map((x) => x.id), ...GRADIENT_BACKGROUNDS.map((x) => x.id)])
        for (const id of [null, ...SWATCHES.map((s) => s.id), ...BUBBLE_GRADIENTS.map((g) => g.id)])
          for (const glass of [15, 100]) {
            const t = resolveTheme({ ...DEFAULT_APPEARANCE, theme: p.id, background: b, myBubble: id, edithBubble: id, glass });
            for (const [side, look] of [['my', t.my], ['edith', t.edith]] as const) if (look.ink !== INK_LIGHT) dark.push(`${p.id}/${b}/${id}/${glass}/${side}`);
          }
    expect(dark).toEqual([]);
  });

  it('white text reads at 4.5:1 on any blur of the wallpaper: every mix of two of its colours, under each bubble’s tint', () => {
    const low: string[] = [];
    const lin = (u: Rgb, v: Rgb, m: number): Rgb => [u[0] + (v[0] - u[0]) * m, u[1] + (v[1] - u[1]) * m, u[2] + (v[2] - u[2]) * m];
    for (const p of PRESETS)
      for (const b of [...BACKGROUNDS.map((x) => x.id), ...GRADIENT_BACKGROUNDS.map((x) => x.id)])
        for (const id of [null, ...SWATCHES.map((s) => s.id)])
          for (const glass of [15, 100]) {
            const t = resolveTheme({ ...DEFAULT_APPEARANCE, theme: p.id, background: b, myBubble: id, edithBubble: id, glass });
            const s = backdropSamples(t.background);
            const mixes = s.flatMap((u, i) => s.slice(i + 1).flatMap((v) => [0.25, 0.5, 0.75].map((m) => lin(u, v, m))));
            for (const look of [t.my, t.edith]) {
              const [r, g, bl, a] = rgbaOf(look.fill) as [number, number, number, number];
              let worst = Infinity;
              for (const u of mixes) {
                const ground: Rgb = [r * a + u[0] * (1 - a), g * a + u[1] * (1 - a), bl * a + u[2] * (1 - a)];
                worst = Math.min(worst, contrast([1, 1, 1], ground));
              }
              // Never worse than the checks without blur (the brightest sample bounds every mix).
              if (worst < Math.min(4.5, look.worst)) low.push(`${p.id}/${b}/${id}/${glass}: ${worst.toFixed(2)}`);
            }
          }
    expect(low).toEqual([]);
    expect(luminance([0.5, 0.5, 0])).toBeLessThan(Math.max(luminance([1, 0, 0]), luminance([0, 1, 0]))); // the convexity it rests on
  });
});

describe('where bubbles are liquid', () => {
  const user = { kind: 'user', id: 1, ts: 0, text: 'hi', origin: 'app', voice: false, attachments: [] } as never;
  const assistant = { kind: 'assistant', id: 2, ts: 0, text: 'hello', lane: 'main' } as never;

  it('only rows marked liquid (the newest) get the lens; older rows are their flat tint', () => {
    const t = at(60);
    const onPress = async () => {};
    expect(native(render(<ItemView item={user} onPress={onPress} liquid />, t))).toHaveLength(1);
    expect(native(render(<ItemView item={assistant} onPress={onPress} liquid />, t))).toHaveLength(1);
    expect(native(render(<ItemView item={user} onPress={onPress} />, t))).toHaveLength(0);
  });

  it('a liquid bubble hides its own edge (the rim is the edge); a flat one keeps it in one colour; a ring keeps the edge', () => {
    const t = at(60);
    const onPress = async () => {};
    const bubble = (r: ReactTestRenderer) => StyleSheet.flatten(r.root.findAll((x) => x.props.style && StyleSheet.flatten(x.props.style)?.borderWidth === 1)[0]!.props.style);
    expect(bubble(render(<ItemView item={assistant} onPress={onPress} liquid />, t)).borderTopColor).toBe('transparent');
    expect(bubble(render(<ItemView item={assistant} onPress={onPress} />, t)).borderTopColor).toBe(t.edith.edge);
    const ringed = render(<ItemView item={assistant} onPress={onPress} liquid highlight />, t);
    expect(bubble(ringed).borderTopColor).toBe(t.accent);
    expect(native(ringed)[0]!.cornerRadius).toBe(radius.l - 1); // the glass inside the ring
  });

  it('the Appearance preview’s bubbles are liquid over the preview’s own wallpaper, like the chat', () => {
    const t = at(60);
    // Native views get tag 7 here; the screen around is a chat whose wallpaper is 42.
    jest.spyOn(require('react-native'), 'findNodeHandle').mockReturnValue(7);
    const r = render(<Preview theme={t} />, t, 'shader', 42);
    const tinted = (look: BubbleLook) => native(r).filter((n) => JSON.stringify(n.tint) === JSON.stringify(rgbaOf(look.fill)) && n.specular === 0 && n.cornerRadius === radius.l);
    expect(tinted(t.edith).map((n) => n.backdrop)).toEqual([7]); // the preview's own wallpaper, never the chat's
    expect(tinted(t.my).map((n) => n.backdrop)).toEqual([7]);
    // Each preview bubble hides its edge for the rim, as in the chat.
    const edge = (id: string) => StyleSheet.flatten(r.root.findAll((x) => x.props.testID === id && x.props.style)[0]!.props.style).borderTopColor;
    expect([edge('preview-edith'), edge('preview-mine')]).toEqual(['transparent', 'transparent']);
    act(() => r.unmount());
  });
});
