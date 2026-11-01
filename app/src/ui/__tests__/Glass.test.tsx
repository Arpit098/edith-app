// Glass's specular rim: drawn over the surface once it knows its size, in place of the hairline
// edge (and of the lens's own specular line), in the scheme's colours, inside the surface's bounds.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, View } from 'react-native';
import { LinearGradient, Path, Stop } from 'react-native-svg';

import { glass, glassEdge, GlassContext, rims, stopOf, type GlassSettings, type NativeGlassProps, type Scheme } from '../../core/theme';
import { bubbleCorners, Glass } from '../Glass';
import { insetOutline, Rim, rimCurve, rimInsets, RIM_SAMPLES, type Corners } from '../Rim';

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
    const svgBefore = r.root.findAllByType(Path).map((x) => x.props);
    expect(svgBefore).toHaveLength(3);
    layout(r, 48, 48); // a move (the keyboard opening) reports the same size: nothing redraws
    expect(r.root.findAllByType(Path).map((x) => x.props)).toEqual(svgBefore);
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

/** A path from insetOutline, read back: its points, and each arc's radius and centre (from its two ends). */
function readOutline(d: string) {
  const tokens = d.split(' ');
  const points: [number, number][] = [];
  const arcs: { r: number; centre: [number, number] }[] = [];
  for (let i = 0; i < tokens.length; ) {
    const c = tokens[i++]!;
    if (c === 'M' || c === 'L') points.push([Number(tokens[i++]), Number(tokens[i++])]);
    else if (c === 'A') {
      const r = Number(tokens[i]);
      i += 5;
      const end: [number, number] = [Number(tokens[i++]), Number(tokens[i++])];
      const start = points[points.length - 1]!;
      // A clockwise quarter turn from `start` to `end`: the centre is the corner of the box they span, inside the shape.
      const centre: [number, number] = end[1] > start[1] === end[0] > start[0] ? [start[0], end[1]] : [end[0], start[1]];
      arcs.push({ r, centre });
      points.push(end);
    }
  }
  return { points, arcs };
}

describe('Rim', () => {
  function paths(width: number, height: number, radius: number, corners?: Corners) {
    const r = render(<Rim width={width} height={height} radius={radius} corners={corners} />);
    return r.root.findAllByType(Path).map((x) => x.props);
  }

  it('is bright at the top-left and bottom-right and fades towards the other corners along a smooth curve, never to nothing', () => {
    const r = render(<Rim width={200} height={48} radius={24} />);
    const g = r.root.findAllByType(LinearGradient).find((x) => x.props.id === 'rim')!;
    expect(g.props).toMatchObject({ x1: '0%', y1: '0%', x2: '100%', y2: '100%' }); // the bounding box's diagonal: scales with the size
    const op = g.findAllByType(Stop).map((s) => s.props.stopOpacity as number);
    expect(op).toHaveLength(RIM_SAMPLES);
    const first = op[0]!;
    const last = op[op.length - 1]!;
    // Lit, yet near the thin glass edge's brightness (0.22): a hairline, not a frame (Arpit, 31 Oct).
    expect(first).toBeGreaterThan(0.3);
    expect(first).toBeLessThanOrEqual(0.6);
    expect(last).toBeGreaterThan(0.3);
    expect(first).toBeGreaterThanOrEqual(last); // the light comes from the top-left
    expect(op[(RIM_SAMPLES - 1) / 2]).toBeLessThan(0.1); // halfway: the top-right and bottom-left corners
    for (const scheme of ['dark', 'light'] as const) {
      const f = rimCurve(rims[scheme]);
      const dim = stopOf(rims[scheme].dim).opacity;
      const xs = Array.from({ length: 401 }, (_, i) => i / 400);
      const v = xs.map(f);
      expect(Math.min(...v)).toBeGreaterThanOrEqual(dim - 1e-9); // thins away, never ends
      expect(Math.min(...v)).toBeGreaterThan(0);
      // Smooth: no jump, and no kink (the slope changes gently everywhere, the old stops' corners gone).
      const d1 = v.slice(1).map((y, i) => y - v[i]!);
      const d2 = d1.slice(1).map((y, i) => y - d1[i]!);
      expect(Math.max(...d1.map(Math.abs))).toBeLessThan(0.01);
      expect(Math.max(...d2.map(Math.abs))).toBeLessThan(0.0005);
      // About `mid` where the rim always had it (the far corner's easing takes a touch off).
      expect(Math.abs(f(0.22) - stopOf(rims[scheme].mid).opacity)).toBeLessThan(0.02);
    }
  });

  it('follows the outline exactly: each stroke inset by half its width, every corner concentric, at any size', () => {
    const sizes: [number, number][] = [
      [72, 40], // a one-word bubble: the corners clamp to half its height
      [220, 44], // one line
      [260, 120], // a few lines
      [300, 900], // a long message
    ];
    for (const [w, h] of sizes) {
      for (const corners of [undefined, bubbleCorners('right'), bubbleCorners('left')]) {
        const shape = corners ?? { tl: 24, tr: 24, br: 24, bl: 24 };
        const fit = Math.min(w / 2, h / 2);
        const centres = {
          tr: [w - Math.min(shape.tr, fit), Math.min(shape.tr, fit)],
          br: [w - Math.min(shape.br, fit), h - Math.min(shape.br, fit)],
          bl: [Math.min(shape.bl, fit), h - Math.min(shape.bl, fit)],
          tl: [Math.min(shape.tl, fit), Math.min(shape.tl, fit)],
        };
        const ins = rimInsets(rims.dark);
        const drawn = paths(w, h, 24, corners);
        expect(drawn.map((p) => p.strokeWidth)).toEqual([ins.shade[1], ins.glow[1], ins.rim[1]]);
        for (const [p, [inset]] of drawn.map((p, i) => [p, [ins.shade, ins.glow, ins.rim][i]!] as const)) {
          expect(p.fill).toBe('none');
          const { points, arcs } = readOutline(p.d);
          // Inside the surface: the stroke's outer side touches the edge at most.
          const half = p.strokeWidth / 2;
          for (const [x, y] of points) {
            expect(x - half).toBeGreaterThanOrEqual(-1e-6);
            expect(y - half).toBeGreaterThanOrEqual(-1e-6);
            expect(x + half).toBeLessThanOrEqual(w + 1e-6);
            expect(y + half).toBeLessThanOrEqual(h + 1e-6);
          }
          // Four corners, in order, each on the outline's own centre with its radius less the inset: no gap or offset.
          expect(arcs).toHaveLength(4);
          (['tr', 'br', 'bl', 'tl'] as const).forEach((k, i) => {
            expect(arcs[i]!.centre[0]).toBeCloseTo(centres[k][0]!, 2);
            expect(arcs[i]!.centre[1]).toBeCloseTo(centres[k][1]!, 2);
            expect(arcs[i]!.r).toBeCloseTo(Math.min(shape[k], fit) - inset, 2);
          });
          // Closed where it started.
          expect(points[points.length - 1]).toEqual(points[0]);
        }
      }
    }
  });

  it('the outline helper: straight sides at the inset, a corner of radius 0 a plain corner', () => {
    const d = insetOutline(100, 50, { tl: 10, tr: 10, br: 0, bl: 10 }, 0.25);
    expect(d.startsWith('M 10 0.25 L 90 0.25 A 9.75 9.75 0 0 1 99.75 10 L 99.75 49.75 L 99.75 49.75')).toBe(true);
  });

  it('is thin: the rim and its inner glow about a hairline each, not a frame', () => {
    for (const scheme of ['dark', 'light'] as const) {
      expect(rims[scheme].width).toBeLessThanOrEqual(1);
      expect(rims[scheme].glowWidth).toBeLessThanOrEqual(1);
    }
  });

  it('draws the shade, then the inner glow, then the rim on top', () => {
    const ins = rimInsets(rims.dark);
    // Each stroke's path starts on the top side at its inset.
    expect(paths(100, 48, 24).map((p) => [Number(p.d.split(' ')[2]), p.strokeWidth])).toEqual([ins.shade, ins.glow, ins.rim]);
  });

  it('draws nothing at zero size', () => {
    expect(paths(0, 48, 24)).toEqual([]);
  });

  it('a closed hairline edge is one colour all round (two colours broke off at the corners); a bar keeps its own', () => {
    const r = render(<Glass level="thin" />);
    const s = outerStyle(r);
    expect([s.borderTopColor, s.borderLeftColor, s.borderRightColor, s.borderBottomColor]).toEqual(Array(4).fill(glassEdge(glass.thin)));
    const bar = outerStyle(render(<Glass level="thick" edges={{ bottom: true }} />));
    expect(bar.borderBottomColor).toBe(glass.thick.edge[1]);
  });
});

describe('Glass popups (the panel level): clear glass, no pane of their own', () => {
  const real = { mode: 'shader' as const, View: FakeNative };
  const scrims = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.testID === 'glass-scrim', { deep: false });

  it('one glass view like any surface: the backdrop bends in a thin band at the edge, no scrim, no second blur', () => {
    const r = render(<Glass level="panel" backdrop={7} radius={30} rim />, real);
    const views = r.root.findAllByType(FakeNative);
    expect(views).toHaveLength(1);
    const p = views[0]!.props;
    expect(p.refraction).toBeGreaterThan(0);
    expect(p.bezel).toBe(glass.panel.bezel);
    expect(p.blur).toBe(glass.panel.blur);
    expect(outerStyle(r).backgroundColor).toBe('transparent');
    expect(scrims(r)).toHaveLength(0);
  });

  it('blur only: still one view and no scrim; the flat fallback keeps its tinted pane', () => {
    const blur = render(<Glass level="panel" backdrop={7} />, { mode: 'blur', View: FakeNative });
    expect(blur.root.findAllByType(FakeNative)).toHaveLength(1);
    expect(scrims(blur)).toHaveLength(0);
    const flat = render(<Glass level="panel" backdrop={7} />);
    expect(flat.root.findAllByType(FakeNative)).toHaveLength(0);
    expect(outerStyle(flat).backgroundColor).toBe(glass.panel.flat);
  });
});
