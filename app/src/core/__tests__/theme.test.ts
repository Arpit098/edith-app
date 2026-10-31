import { colors, glass, glassBase, glassMode, glassTint, rgbaOf } from '../theme';

describe('glassMode (what the device can afford)', () => {
  it.each([
    [36, false, 'shader'],
    [33, false, 'shader'],
    [32, false, 'blur'],
    [31, false, 'blur'],
    [30, false, 'flat'],
    [36, true, 'flat'], // battery saver
    [null, false, 'flat'], // no native module (jest, web)
  ] as const)('sdk %s, battery saver %s → %s', (sdk, saving, mode) => {
    expect(glassMode(sdk, saving)).toBe(mode);
  });
});

describe('glass tints for the native view', () => {
  it('parses rgba() and rgb() into 0..1', () => {
    expect(rgbaOf('rgba(255, 0, 51, 0.5)')).toEqual([1, 0, 0.2, 0.5]);
    expect(rgbaOf('rgb(0, 255, 0)')).toEqual([0, 1, 0, 1]);
    expect(rgbaOf('#ff0033')).toEqual([1, 0, 0.2, 1]);
    expect(rgbaOf('#fff')).toEqual([0, 0, 0, 0]); // not a form the tokens use: no tint rather than a wrong one
  });

  it('every level has a parsed tint matching its token', () => {
    for (const level of ['thin', 'regular', 'thick', 'control', 'panel'] as const) {
      expect(glassTint[level]).toEqual(rgbaOf(glass[level].tint));
      expect(glassTint[level][3]).toBeGreaterThan(0);
    }
  });
});

describe('the frost (Arpit, 13R: text showed through the glass sharp)', () => {
  it('lays the backdrop over the opaque app background', () => {
    expect(glassBase).toEqual(rgbaOf(colors.bg));
    expect(glassBase[3]).toBe(1);
  });

  it('blurs 24–32 dp, lifts saturation 1.4–1.8x, splits RGB by under a dp, and the fallback is nearly opaque', () => {
    for (const level of ['thin', 'regular', 'thick', 'control', 'panel'] as const) {
      const g = glass[level];
      expect(g.blur).toBeGreaterThanOrEqual(24);
      expect(g.blur).toBeLessThanOrEqual(32);
      expect(g.saturation).toBeGreaterThanOrEqual(1.4);
      expect(g.saturation).toBeLessThanOrEqual(1.8);
      expect(g.dispersion).toBeGreaterThan(0);
      expect(g.dispersion).toBeLessThanOrEqual(1);
      expect(rgbaOf(g.flat)[3]).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('text panels (status card, menus)', () => {
  it('a dark scrim at 0.75–0.85 over the content area, so what is behind reads only as colour', () => {
    const [r, g, b, a] = rgbaOf(glass.panel.legibility!.scrim);
    expect(a).toBeGreaterThanOrEqual(0.75);
    expect(a).toBeLessThanOrEqual(0.85);
    expect(Math.max(r!, g!, b!)).toBeLessThan(0.3); // dark
  });

  it('a light tint and a strong lens on the rim, so the backdrop visibly bends there (Liquid Glass)', () => {
    expect(rgbaOf(glass.panel.tint)[3]).toBeLessThanOrEqual(0.4);
    expect(glass.panel.refraction).toBeGreaterThanOrEqual(glass.regular.refraction);
    expect(glass.panel.legibility!.centreBlur).toBeGreaterThan(glass.panel.blur);
  });
});
