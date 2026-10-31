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

  it('chrome blurs 24–32 dp, lifts saturation 1.4–1.8x, splits RGB by under a dp, and the fallback is nearly opaque', () => {
    for (const level of ['thin', 'regular', 'thick', 'control', 'panel'] as const) {
      const g = glass[level];
      if (level === 'panel') {
        expect(g.blur).toBeGreaterThanOrEqual(10); // popups: a light blur, they're clear glass
        expect(g.blur).toBeLessThanOrEqual(16);
      } else {
        expect(g.blur).toBeGreaterThanOrEqual(24);
        expect(g.blur).toBeLessThanOrEqual(32);
      }
      expect(g.saturation).toBeGreaterThanOrEqual(1.4);
      expect(g.saturation).toBeLessThanOrEqual(1.8);
      expect(g.dispersion).toBeGreaterThan(0);
      expect(g.dispersion).toBeLessThanOrEqual(1);
      expect(rgbaOf(g.flat)[3]).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('the bend at the edge (Arpit, 31 Oct: "the bending on the border is thick")', () => {
  it('a thin band, at most 8 dp on every level (it was 14–22), still bending visibly', () => {
    for (const level of ['thin', 'regular', 'thick', 'control', 'panel'] as const) {
      const g = glass[level];
      expect(g.bezel).toBeLessThanOrEqual(8);
      expect(g.refraction).toBeGreaterThanOrEqual(3); // a clearly visible bend at the very edge
      expect(g.refraction).toBeLessThan(g.bezel); // never pulling from further in than the band is wide
    }
  });

  it('popups are as thin as the thinnest chrome', () => {
    expect(glass.panel.bezel).toBeLessThanOrEqual(Math.min(glass.thin.bezel, glass.regular.bezel, glass.thick.bezel, glass.control.bezel));
  });
});
