import { glass, glassMode, glassTint, rgbaOf } from '../theme';

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
    expect(rgbaOf('#fff')).toEqual([0, 0, 0, 0]); // not a form the tokens use: no tint rather than a wrong one
  });

  it('every level has a parsed tint matching its token', () => {
    for (const level of ['thin', 'regular', 'thick'] as const) {
      expect(glassTint[level]).toEqual(rgbaOf(glass[level].tint));
      expect(glassTint[level][3]).toBeGreaterThan(0);
    }
  });
});
