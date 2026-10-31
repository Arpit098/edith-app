// Popup legibility, the documented check: every text colour used on popup glass keeps WCAG AA
// (4.5:1) over any backdrop, in every glass mode, assuming the glass itself does nothing to help
// (worstPopupContrast). If a token change breaks this, the popup text would be unreadable over a
// bright image scrolling behind a menu: change the scrim or the text colour, not this test.

import { BACKDROPS, colors, composite, contrast, glass, luminance, worstPopupContrast, type GlassLevel, type Rgb } from '..';

const AA = 4.5;
const POPUP_LEVELS = (Object.keys(glass) as GlassLevel[]).filter((l) => glass[l].legibility);
// Every colour popup text is drawn in (ComposerMenu, NavMenu, the status card).
const POPUP_TEXT = { text: colors.text, textSecondary: colors.textSecondary };

describe('contrast maths', () => {
  it('matches the WCAG reference values', () => {
    expect(luminance([1, 1, 1])).toBeCloseTo(1);
    expect(luminance([0, 0, 0])).toBe(0);
    expect(contrast([1, 1, 1], [0, 0, 0])).toBeCloseTo(21);
    expect(contrast([0.4627, 0.4627, 0.4627], [1, 1, 1])).toBeCloseTo(4.54, 1); // #767676 on white: the AA grey
  });

  it('composites a translucent colour over another', () => {
    expect(composite('rgba(0, 0, 0, 0.5)', [1, 1, 1])).toEqual([0.5, 0.5, 0.5]);
    expect(composite('#ffffff', [0, 0, 0])).toEqual([1, 1, 1]);
  });
});

describe('popup glass legibility', () => {
  it('the panel is a popup level', () => {
    expect(POPUP_LEVELS).toContain('panel');
  });

  for (const level of POPUP_LEVELS) {
    for (const [name, css] of Object.entries(POPUP_TEXT)) {
      it(`${level}: ${name} keeps ${AA}:1 over any backdrop, in every mode`, () => {
        expect(worstPopupContrast(level, css)).toBeGreaterThanOrEqual(AA);
      });
    }

    it(`${level}: the current row in a menu (accent tint) still keeps ${AA}:1`, () => {
      const scrim = glass[level].legibility!.scrim;
      for (const backdrop of Object.values(BACKDROPS)) {
        const row = composite(colors.accentSoft, composite(scrim, backdrop));
        expect(contrast(composite(colors.text, row), row)).toBeGreaterThanOrEqual(AA);
      }
    });

    it(`${level}: the worst case really is a white backdrop`, () => {
      const scrim = glass[level].legibility!.scrim;
      const bgs = Object.entries(BACKDROPS).map(([k, b]) => [k, luminance(composite(scrim, b))] as [string, number]);
      const brightest = bgs.reduce((a, b) => (b[1] > a[1] ? b : a));
      expect(brightest[0]).toBe('white');
    });

    it(`${level}: popup text sits inside the scrim (its inset is smaller than the menus' padding)`, () => {
      // ComposerMenu: 4 (list) + 12 (row) dp to the text; NavMenu: 4 + 16; the status card: 12.
      expect(glass[level].legibility!.inset).toBeLessThanOrEqual(12);
    });
  }

  it('the other levels have no popup treatment (chrome stays light)', () => {
    for (const level of ['thin', 'regular', 'thick', 'control'] as GlassLevel[]) expect(glass[level].legibility).toBeUndefined();
  });

  it("the white backdrop's numbers, for the record", () => {
    const g = glass.panel.legibility!;
    const bg: Rgb = composite(g.scrim, BACKDROPS.white!);
    // Printed in the PR: text on the panel over pure white.
    expect(contrast(composite(colors.text, bg), bg)).toBeGreaterThan(5.5);
  });
});
