// Themes: every preset, background, bubble colour and glass amount keeps chat text at 4.5:1 or more;
// the glass mapping keeps the old look at 60% and rims thin; stored choices are made whole.

import { contrast, composite } from '../contrast';
import { glass } from '../tokens';
import {
  BACKGROUNDS,
  backdropSamples,
  bubbleLook,
  DEFAULT_APPEARANCE,
  fitBubbleAlpha,
  glassAt,
  INK_DARK,
  INK_LIGHT,
  inkOn,
  normalizeAppearance,
  PRESETS,
  resolveTheme,
  rgbOf,
  rimStrength,
  SWATCHES,
  withAlpha,
} from '../themes';

const AMOUNTS = [0, 15, 30, 45, 60, 75, 90, 100];
const BUBBLES = [null, ...SWATCHES.map((s) => s.id)];

describe('chat text on every bubble', () => {
  it('reads at 4.5:1 or more: every preset × background × colour × glass amount, both sides, quotes included', () => {
    const failures: string[] = [];
    let checked = 0;
    const worst = (css: string, grounds: readonly (readonly [number, number, number])[]) => Math.min(...grounds.map((u) => contrast(composite(css, u), u)));
    for (const p of PRESETS) {
      for (const b of BACKGROUNDS) {
        for (const id of BUBBLES) {
          for (const glassAmount of AMOUNTS) {
            const t = resolveTheme({ theme: p.id, background: b.id, myBubble: id, edithBubble: id, glass: glassAmount });
            for (const [side, look] of [['mine', t.my], ['edith', t.edith]] as const) {
              checked++;
              // Recomputed here, independently: the ink over the bubble over every backdrop colour…
              const under = backdropSamples(t.background).map((u) => composite(look.fill, u));
              // …and over the quote's pane on top of that.
              const pane = under.map((u) => composite(look.inkSoft, u));
              const scores = {
                text: worst(look.ink, under),
                captions: worst(look.inkDim, under),
                quoteFrom: worst(look.ink, pane), // the quote's "EDITH"/"You": the full ink
                quote: worst(look.quoteDim, pane),
              };
              const low = Object.entries(scores).filter(([, v]) => v < 4.5);
              if (low.length) failures.push(`${p.id}/${b.id}/${id ?? 'default'}/${glassAmount}%/${side}: ${low.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
            }
          }
        }
      }
    }
    expect(checked).toBe(PRESETS.length * BACKGROUNDS.length * BUBBLES.length * AMOUNTS.length * 2);
    expect(failures).toEqual([]);
  });

  it('picks dark text on a light bubble and light text on a dark one', () => {
    const look = resolveTheme(DEFAULT_APPEARANCE).background;
    expect(bubbleLook('#F2C94C', 1, 60, look).ink).toBe(INK_DARK); // solid yellow
    expect(bubbleLook('#FFFFFF', 0.07, 60, look).ink).toBe(INK_LIGHT); // EDITH's faint pane
  });

  it('keeps every chosen colour strong enough to read as that colour', () => {
    const weak: string[] = [];
    for (const p of PRESETS) {
      for (const b of BACKGROUNDS) {
        const look = resolveTheme({ ...DEFAULT_APPEARANCE, theme: p.id, background: b.id }).background;
        for (const s of SWATCHES) {
          const a = fitBubbleAlpha(s.color, look);
          if (a < 0.3) weak.push(`${p.id}/${b.id}/${s.id}: ${a}`);
        }
      }
    }
    expect(weak).toEqual([]);
  });

  it('looks the same on the plain background from 0% to 60%: only more solid', () => {
    const plain = resolveTheme({ ...DEFAULT_APPEARANCE, background: 'plain' }).background;
    const bg = rgbOf(plain.bg);
    const at = (amount: number) => composite(bubbleLook('#3D7FD9', 0.55, amount, plain).fill, bg).map((v) => Math.round(v * 255));
    expect(at(0)).toEqual(at(60));
    expect(at(30)).toEqual(at(60));
  });
});

describe('the glass amount', () => {
  it('is the original look at 60%', () => {
    for (const level of Object.keys(glass) as (keyof typeof glass)[]) {
      const g = glassAt(level, 60);
      expect(g.blur).toBeCloseTo(glass[level].blur);
      expect(g.refraction).toBeCloseTo(glass[level].refraction);
      expect(g.rimWidth).toBe(glass[level].rimWidth);
      expect(rgbaClose(g.tint, glass[level].tint)).toBe(true);
      expect(rgbaClose(g.flat, glass[level].flat)).toBe(true);
    }
  });

  it('is flat and near-solid at 0%, and more glass (never a wider rim) up to 100%', () => {
    const zero = glassAt('regular', 0);
    expect([zero.blur, zero.refraction, zero.specular]).toEqual([0, 0, 0]);
    expect(alphaOf(zero.flat)).toBeGreaterThanOrEqual(0.97);
    const max = glassAt('regular', 100);
    expect(max.blur).toBeGreaterThan(glass.regular.blur);
    expect(max.refraction).toBeGreaterThan(glass.regular.refraction);
    expect(alphaOf(max.tint)).toBeLessThan(alphaOf(glass.regular.tint));
    expect(alphaOf(max.flat)).toBe(alphaOf(glass.regular.flat)); // the fallback's text keeps its contrast
    expect(max.rimWidth).toBe(glass.regular.rimWidth);
    expect(max.bezel).toBe(glass.regular.bezel);
    expect([rimStrength(0), rimStrength(60), rimStrength(100)]).toEqual([0, 1, 1]);
  });

  it('is 0 when the system asks for less transparency', () => {
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, glass: 90 }, true).glass).toBe(0);
  });
});

describe('the themes', () => {
  it('Midnight with the defaults is the app as it was', () => {
    const t = resolveTheme(DEFAULT_APPEARANCE);
    expect([t.bg, t.accent, t.glass]).toEqual(['#05070A', '#7CAEDC', 60]);
    expect(t.my.fill).toBe('rgba(124, 174, 220, 0.24)');
    expect(t.edith.fill).toBe('rgba(255, 255, 255, 0.07)');
  });

  it('a swatch’s check mark reads at 3:1 or more on every swatch, the theme-default ones included', () => {
    const low: string[] = [];
    for (const p of PRESETS) {
      const swatches = [...SWATCHES.map((s) => s.color), withAlpha(p.accent, 0.35), withAlpha('#FFFFFF', 0.35)];
      for (const c of swatches) {
        const under = composite(c, rgbOf(p.bg));
        const ratio = contrast(rgbOf(inkOn(c, p.bg)), under);
        if (ratio < 3) low.push(`${p.id}/${c}: ${ratio.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
    expect(inkOn('#F2C94C', '#05070A')).toBe(INK_DARK); // yellow: a black check
    expect(inkOn(withAlpha('#7CAEDC', 0.35), '#05070A')).toBe(INK_LIGHT); // the faint theme-default swatch: a white one
  });

  it('text on the accent reads on every preset', () => {
    for (const p of PRESETS) {
      const t = resolveTheme({ ...DEFAULT_APPEARANCE, theme: p.id });
      expect(contrast(rgbOf(t.accentText), rgbOf(t.accent))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('has about 6 to 8 presets and about 10 swatches, all distinct', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(6);
    expect(PRESETS.length).toBeLessThanOrEqual(8);
    expect(SWATCHES).toHaveLength(10);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
    expect(new Set(SWATCHES.map((s) => s.color)).size).toBe(SWATCHES.length);
  });

  it('makes a stored appearance whole and valid', () => {
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ theme: 'nope', myBubble: 'teal', edithBubble: 'mauve', background: 'grid', glass: 140 })).toEqual({
      theme: 'midnight',
      myBubble: 'teal',
      edithBubble: null,
      background: 'grid',
      glass: 100,
    });
    expect(normalizeAppearance({ glass: -3.4 }).glass).toBe(0);
  });
});

function alphaOf(css: string): number {
  const m = /,\s*([\d.]+)\)$/.exec(css);
  return m ? Number(m[1]) : 1;
}

function rgbaClose(a: string, b: string): boolean {
  const nums = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
  const [x, y] = [nums(a), nums(b)];
  return x.length === y.length && x.every((v, i) => Math.abs(v - y[i]!) < 0.006 * (i === 3 ? 1 : 255));
}
