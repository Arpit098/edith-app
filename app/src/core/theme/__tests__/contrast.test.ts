// Popup legibility, and its trade-off (Arpit, 31 Oct: "popups don't have to have their own
// background, they'll refract what's behind like liquid glass").
//
// Popups (the composer menu, the nav menu, the status card) are clear Liquid Glass: a light blur, a
// very faint tint, a thin bend at the edge, and no scrim or pane behind the labels. So on real glass
// the background under the text is whatever is behind the popup, and no WCAG ratio can be promised:
// over a bright photo, white text on the glass alone is close to 1:1. What keeps it readable is
// - the labels' own dark halo (legibleText: a strong, wide, centred shadow; icons get it too),
// - a slightly heavier weight (500 and up), so the halo has a glyph to hug,
// - the blur, which turns what's behind into colour and shapes rather than competing text.
// WCAG ratios don't model a text shadow, so this file checks that those pieces are there, not a
// number. Only the flat fallback (no blur at all) keeps a tinted pane, and that one is exact: 4.5:1.

import fs from 'fs';
import path from 'path';

import { BACKDROPS, colors, composite, contrast, glass, legibleText, luminance, rgbaOf, worstFlatContrast } from '..';

const AA = 4.5;
const SRC = path.resolve(__dirname, '../../..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** The text styles each popup draws on its glass. */
const POPUP_TEXT_STYLES: Record<string, string[]> = {
  'shell/NavMenu.tsx': ['itemText'],
  'features/live-session/ComposerMenu.tsx': ['label', 'commandName', 'commandText', 'note'],
  'features/live-session/StatusPanel.tsx': [
    'cardDim', 'error', 'summaryTitle', 'summaryDetail', 'summaryTime', 'sectionTitle', 'label', 'value', 'cardButtonText', 'agentName', 'agentBranch', 'agentState', 'agentLast',
  ],
};

/** A style's one-line definition in the file's StyleSheet.create block. */
function styleLine(source: string, name: string): string {
  const block = source.slice(source.indexOf('StyleSheet.create('));
  const line = block.split('\n').find((l) => l.trimStart().startsWith(`${name}: {`));
  if (!line) throw new Error(`no style ${name}`);
  return line;
}

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

describe('popups are clear glass', () => {
  it('a very faint tint and a light blur: no pane of their own', () => {
    expect(rgbaOf(glass.panel.tint)[3]).toBeLessThanOrEqual(0.2);
    expect(glass.panel.blur).toBeLessThan(glass.regular.blur);
    expect(glass.panel.lift).toBe(0); // no brightening under white text
    expect(Object.keys(glass.panel)).not.toContain('legibility'); // the old scrim and centre blur are gone
  });

  it('the trade-off, for the record: on real glass the tint alone gives no 4.5:1 over a white backdrop', () => {
    // So the claim isn't made: readability comes from the halo, the weight and the blur (below).
    const bg = composite(glass.panel.tint, BACKDROPS.white!);
    expect(contrast(composite(colors.text, bg), bg)).toBeLessThan(AA);
  });
});

describe('popup text carries its own halo', () => {
  it('the halo is dark, strong, wide and centred (a halo, not a drop shadow)', () => {
    const [r, g, b, a] = rgbaOf(legibleText.textShadowColor);
    expect(Math.max(r!, g!, b!)).toBeLessThanOrEqual(0.1);
    expect(a).toBeGreaterThanOrEqual(0.75);
    expect(legibleText.textShadowRadius).toBeGreaterThanOrEqual(5);
    expect(Math.abs(legibleText.textShadowOffset.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(legibleText.textShadowOffset.height)).toBeLessThanOrEqual(1);
  });

  for (const [file, names] of Object.entries(POPUP_TEXT_STYLES)) {
    const source = read(file);
    for (const name of names) {
      it(`${file}: ${name} has the halo, full-opacity text colour and weight 500+`, () => {
        const line = styleLine(source, name);
        expect(line).toContain('...legibleText');
        expect(line).toMatch(/color: colors\.(text|textSecondary|danger)\b/);
        expect(line).not.toMatch(/opacity:/);
        const weight = /fontWeight: '(\d00)'/.exec(line);
        expect(Number(weight?.[1])).toBeGreaterThanOrEqual(500);
      });
    }
  }

  it('icons on the popups carry the halo too', () => {
    const menu = read('features/live-session/ComposerMenu.tsx');
    const nav = read('shell/NavMenu.tsx');
    const status = read('features/live-session/StatusPanel.tsx');
    const icons = [...menu.split('\n'), ...nav.slice(nav.indexOf('<Glass level="panel"')).split('\n'), ...status.split('\n')].filter((l) => l.includes('<Icon '));
    expect(icons.length).toBeGreaterThanOrEqual(5);
    for (const l of icons) expect(l).toContain(' halo');
  });
});

describe('the flat fallback (no blur) keeps a tinted pane', () => {
  for (const [name, css] of Object.entries({ text: colors.text, textSecondary: colors.textSecondary })) {
    it(`${name} keeps ${AA}:1 over any backdrop there`, () => {
      expect(worstFlatContrast('panel', css)).toBeGreaterThanOrEqual(AA);
    });
  }

  it('the current row in a menu (accent tint) still keeps 4.5:1 there', () => {
    for (const backdrop of Object.values(BACKDROPS)) {
      const row = composite(colors.accentSoft, composite(glass.panel.flat, backdrop));
      expect(contrast(composite(colors.text, row), row)).toBeGreaterThanOrEqual(AA);
    }
  });
});
