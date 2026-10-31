// Glass's specular rim: drawn over the surface once it knows its size, in place of the hairline
// edge (and of the lens's own specular line), in the scheme's colours, inside the surface's bounds.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, View } from 'react-native';
import { LinearGradient, Rect, Stop } from 'react-native-svg';

import { glass, GlassContext, rims, stopOf, type GlassSettings, type NativeGlassProps, type Scheme } from '../../core/theme';
import { Glass } from '../Glass';
import { Rim, rimInsets } from '../Rim';

function FakeNative(_: NativeGlassProps) {
  return null;
}

function render(node: React.ReactElement, settings: Partial<GlassSettings> = {}): ReactTestRenderer {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<GlassContext.Provider value={{ mode: 'flat', View: null, reduceMotion: false, ...settings }}>{node}</GlassContext.Provider>);
  });
  return r;
}

function layout(r: ReactTestRenderer, width: number, height: number) {
  const outer = r.root.findAllByType(View)[0]!;
  act(() => outer.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));
}

const outerStyle = (r: ReactTestRenderer) => StyleSheet.flatten(r.root.findAllByType(View)[0]!.props.style);

// The Rim element Glass renders (a memo component: matched by its props, not its type).
const rimsIn = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.props.radius === 'number' && 'scheme' in n.props && n.props.width !== undefined, { deep: false });
const rimOf = (r: ReactTestRenderer) => {
  const found = rimsIn(r);
  expect(found).toHaveLength(1);
  return found[0]!;
};

afterEach(() => jest.restoreAllMocks());

describe('Glass rim', () => {
  it('without rim: the hairline edge, no layout listener, no rim', () => {
    const r = render(<Glass />);
    expect(outerStyle(r).borderTopWidth).toBe(StyleSheet.hairlineWidth);
    expect(r.root.findAllByType(View)[0]!.props.onLayout).toBeUndefined();
    expect(rimsIn(r)).toHaveLength(0);
  });

  it('with rim: no hairline edge; the rim appears once the size is known and follows size changes only', () => {
    const r = render(<Glass rim radius={24} />);
    expect(outerStyle(r)).toMatchObject({ borderTopWidth: 0, borderLeftWidth: 0, borderRightWidth: 0, borderBottomWidth: 0 });
    expect(rimsIn(r)).toHaveLength(0);
    layout(r, 48, 48);
    const first = rimOf(r);
    expect(first.props).toMatchObject({ width: 48, height: 48, radius: 24, scheme: undefined });
    const svgBefore = r.root.findAllByType(Rect).map((x) => x.props);
    layout(r, 48, 48); // a move (the keyboard opening) reports the same size: nothing redraws
    expect(r.root.findAllByType(Rect).map((x) => x.props)).toEqual(svgBefore);
    layout(r, 300, 48);
    expect(rimOf(r).props).toMatchObject({ width: 300, height: 48 });
  });

  it('turns the lens specular line off on real glass (the rim is the edge light)', () => {
    const real = { mode: 'shader' as const, View: FakeNative };
    const plain = render(<Glass backdrop={7} />, real);
    expect(plain.root.findByType(FakeNative).props.specular).toBeGreaterThan(0);
    const rimmed = render(<Glass backdrop={7} rim />, real);
    expect(rimmed.root.findByType(FakeNative).props.specular).toBe(0);
  });

  it("takes the scheme's colours", () => {
    for (const scheme of ['dark', 'light'] as Scheme[]) {
      const r = render(<Glass rim />, { scheme });
      layout(r, 200, 48);
      expect(rimOf(r).props.scheme).toBe(scheme);
      const rim = r.root.findAllByType(LinearGradient).find((g) => g.props.id === 'rim')!;
      const stops = rim.findAllByType(Stop).map((s) => s.props);
      expect(stops[0]).toMatchObject({ offset: '0%', stopColor: stopOf(rims[scheme].lit).color, stopOpacity: stopOf(rims[scheme].lit).opacity });
    }
  });
});

describe('Rim', () => {
  function rects(width: number, height: number, radius: number) {
    const r = render(<Rim width={width} height={height} radius={radius} />);
    return r.root.findAllByType(Rect).map((x) => x.props);
  }

  it('is bright at the top-left and bottom-right, nearly clear at the other corners', () => {
    const r = render(<Rim width={200} height={48} radius={24} />);
    const g = r.root.findAllByType(LinearGradient).find((x) => x.props.id === 'rim')!;
    expect(g.props).toMatchObject({ x1: '0%', y1: '0%', x2: '100%', y2: '100%' }); // the bounding box's diagonal
    const op = g.findAllByType(Stop).map((s) => s.props.stopOpacity as number);
    const mid = op[2]!;
    // Lit, yet near the thin glass edge's brightness (0.22): a hairline, not a frame (Arpit, 31 Oct).
    expect(op[0]).toBeGreaterThan(0.3); // top-left
    expect(op[0]).toBeLessThanOrEqual(0.6);
    expect(op[4]).toBeGreaterThan(0.3); // bottom-right
    expect(mid).toBeLessThan(0.1); // halfway along the diagonal: the top-right and bottom-left corners
    expect(op[0]).toBeGreaterThanOrEqual(op[4]!); // the light comes from the top-left
  });

  it('keeps every stroke inside the surface, with corners that follow its radius', () => {
    for (const [w, h, radius] of [
      [48, 48, 24],
      [300, 48, 999], // a pill: the radius is clamped to half the height
      [240, 300, 30],
    ] as const) {
      for (const p of rects(w, h, radius)) {
        const half = p.strokeWidth / 2;
        expect(p.x - half).toBeGreaterThanOrEqual(0);
        expect(p.y - half).toBeGreaterThanOrEqual(0);
        expect(p.x + p.width + half).toBeLessThanOrEqual(w);
        expect(p.y + p.height + half).toBeLessThanOrEqual(h);
        expect(p.rx).toBeCloseTo(Math.min(radius, w / 2, h / 2) - p.x);
        expect(p.fill).toBe('none');
      }
    }
  });

  it('is thin: the rim and its inner glow about a hairline each, not a frame', () => {
    for (const scheme of ['dark', 'light'] as const) {
      expect(rims[scheme].width).toBeLessThanOrEqual(1);
      expect(rims[scheme].glowWidth).toBeLessThanOrEqual(1);
    }
  });

  it('draws the shade, then the inner glow, then the rim on top', () => {
    const ins = rimInsets(rims.dark);
    expect(rects(100, 48, 24).map((p) => [p.x, p.strokeWidth])).toEqual([ins.shade, ins.glow, ins.rim]);
  });

  it('draws nothing at zero size', () => {
    expect(rects(0, 48, 24)).toEqual([]);
  });
});

describe('Glass popup legibility (the panel level)', () => {
  const real = { mode: 'shader' as const, View: FakeNative };
  const scrimOf = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.testID === 'glass-scrim', { deep: false });

  it('a popup gets a harder-blurred content area and a scrim over it, inside the rim', () => {
    const r = render(<Glass level="panel" backdrop={7} radius={30} rim />, real);
    const views = r.root.findAllByType(FakeNative);
    expect(views).toHaveLength(2);
    const [rimView, centre] = views.map((v) => v.props);
    expect(rimView!.refraction).toBeGreaterThan(0); // the rim bends the backdrop
    expect(centre!.refraction).toBe(0); // the content area doesn't swim
    expect(centre!.dispersion).toBe(0);
    expect(centre!.blur).toBeGreaterThan(rimView!.blur); // stronger blur in the centre than at the edge
    const legibility = glass.panel.legibility!;
    expect(centre!.cornerRadius).toBe(30 - legibility.inset);
    const scrim = StyleSheet.flatten(scrimOf(r)[0]!.props.style);
    expect(scrim).toMatchObject({ margin: legibility.inset, backgroundColor: legibility.scrim, borderRadius: 30 - legibility.inset });
  });

  it('the scrim is there in the flat fallback and blur-only modes too (it is what guarantees the contrast)', () => {
    for (const settings of [{}, { mode: 'blur' as const, View: FakeNative }]) {
      const r = render(<Glass level="panel" backdrop={7} />, settings);
      expect(scrimOf(r)).toHaveLength(1);
    }
    expect(render(<Glass level="panel" />).root.findAllByType(FakeNative)).toHaveLength(0); // no backdrop: flat, one layer
  });

  it('chrome levels get neither (the composer stays light)', () => {
    for (const level of ['thin', 'regular', 'thick', 'control'] as const) {
      const r = render(<Glass level={level} backdrop={7} />, real);
      expect(scrimOf(r)).toHaveLength(0);
      expect(r.root.findAllByType(FakeNative)).toHaveLength(1);
    }
  });
});
