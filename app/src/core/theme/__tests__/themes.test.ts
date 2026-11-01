// Themes: every preset, background (theme-coloured, gradient, custom), bubble colour or gradient,
// accent and glass amount keeps text at 4.5:1 or more; the glass mapping keeps the old look at 60%
// and rims thin; stored choices (old and new) are made whole.

import { contrast, composite, luminance, type Rgb } from '../contrast';
import { colors, glass, rgbaOf } from '../tokens';
import {
  ACCENTS,
  anglePoints,
  BACKGROUND_LUMINANCE,
  BACKGROUNDS,
  backdropSamples,
  backgroundLook,
  BUBBLE_GRADIENTS,
  bubbleLook,
  coverRect,
  cutAxis,
  DEFAULT_APPEARANCE,
  fitBubbleAlpha,
  glassAt,
  GRADIENT_BACKGROUNDS,
  hexToHsv,
  hsvToHex,
  INK_DARK,
  INK_LIGHT,
  inkOn,
  MAX_CUSTOM,
  MAX_PHOTOS,
  nextCustomId,
  normalizeAppearance,
  PHOTO_DIM_LIMIT,
  photoTones,
  PRESETS,
  resolveTheme,
  rgbOf,
  rimStrength,
  SWATCHES,
  tame,
  UNKNOWN_TONES,
  withAlpha,
  type Appearance,
  type BubbleLook,
  type CustomGradient,
  type Photo,
  type PhotoBackground,
  type Theme,
} from '../themes';

jest.setTimeout(120_000);

const AMOUNTS = [0, 15, 30, 45, 60, 75, 90, 100];
const COLOURS = [null, ...SWATCHES.map((s) => s.id)];
const GRADIENT_BUBBLES = BUBBLE_GRADIENTS.map((b) => b.id);
/** The builder's extremes: the brightest colours at full intensity, linear and radial, and the darkest. */
const EXTREMES: CustomGradient[] = [
  { id: 'custom-1', stops: ['#FFFFFF', '#FFFF00', '#00FFFF', '#FF00FF'], angle: 45, kind: 'linear', intensity: 100 },
  { id: 'custom-2', stops: ['#FFFFFF', '#00FF00'], angle: 0, kind: 'radial', intensity: 100 },
  { id: 'custom-3', stops: ['#FFFFFF', '#FF0000', '#0000FF'], angle: 200, kind: 'linear', intensity: 0 },
];
/** A builder's bubble gradients over the whole colour wheel, bright and dim, white and yellow included. */
const CUSTOM_BUBBLES = [
  { stops: ['#FFFFFF', '#FFFF00'] as [string, string], angle: 90 },
  { stops: ['#000000', '#FFFFFF'] as [string, string], angle: 0 },
  ...[0, 60, 120, 180, 240, 300].map((h) => ({ stops: [hsvToHex(h, 1, 1), hsvToHex(h + 150, 0.6, 0.5)] as [string, string], angle: h })),
];

/** A CSS colour laid over an opaque one: parsed once, then plain maths (this file checks millions). */
const layer = (css: string) => {
  const [r, g, b, a] = rgbaOf(css) as [number, number, number, number];
  return (u: Rgb): Rgb => [r * a + u[0] * (1 - a), g * a + u[1] * (1 - a), b * a + u[2] * (1 - a)];
};
const worst = (css: string, grounds: readonly Rgb[]) => {
  const on = layer(css);
  return grounds.reduce((least, u) => Math.min(least, contrast(on(u), u)), Infinity);
};
const mixed = (a: Rgb, b: Rgb, m: number): Rgb => [a[0] + (b[0] - a[0]) * m, a[1] + (b[1] - a[1]) * m, a[2] + (b[2] - a[2]) * m];

/** Recomputed here, independently of bubbleLook: every point of the bubble (each stop and between) over every backdrop. */
function grounds(t: Theme, look: BubbleLook): Rgb[] {
  const stops = (look.gradient ? look.gradient.colors : [look.fill]).map(layer);
  return backdropSamples(t.background).flatMap((u) => {
    const each = stops.map((on) => on(u));
    return each.flatMap((c, i) => (i === 0 ? [c] : [0.1, 0.3, 0.5, 0.7, 0.9].map((m) => mixed(each[i - 1]!, c, m)).concat([c])));
  });
}

/** Every side of a theme: text, captions, the quote's "EDITH"/"You" (full ink) and the quote, both on its pane. */
function lowScores(t: Theme, label: string, out: string[]) {
  for (const [side, look] of [['mine', t.my], ['edith', t.edith]] as const) {
    const under = grounds(t, look);
    const pane = under.map(layer(look.inkSoft));
    const scores = { text: worst(look.ink, under), captions: worst(look.inkDim, under), quoteFrom: worst(look.ink, pane), quote: worst(look.quoteDim, pane) };
    const low = Object.entries(scores).filter(([, v]) => v < 4.5);
    if (low.length) out.push(`${label}/${side}: ${low.map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')}`);
  }
}

const appearance = (a: Partial<Appearance>): Appearance => ({ ...DEFAULT_APPEARANCE, customGradients: EXTREMES, ...a });

describe('chat text on every bubble', () => {
  it('reads at 4.5:1 or more: every preset × theme background × colour × glass amount, both sides, quotes included', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const p of PRESETS) {
      for (const b of BACKGROUNDS) {
        for (const id of COLOURS) {
          for (const glassAmount of AMOUNTS) {
            checked++;
            lowScores(resolveTheme(appearance({ theme: p.id, background: b.id, myBubble: id, edithBubble: id, glass: glassAmount })), `${p.id}/${b.id}/${id ?? 'default'}/${glassAmount}%`, failures);
          }
        }
      }
    }
    expect(checked).toBe(PRESETS.length * BACKGROUNDS.length * COLOURS.length * AMOUNTS.length);
    expect(failures).toEqual([]);
  });

  it('reads at 4.5:1 or more on every gradient and custom background, with every colour and gradient bubble', () => {
    const failures: string[] = [];
    const backgrounds = [...GRADIENT_BACKGROUNDS.map((b) => b.id), ...EXTREMES.map((c) => c.id)];
    for (const bg of backgrounds) {
      for (const id of [...COLOURS, ...GRADIENT_BUBBLES]) {
        for (const glassAmount of AMOUNTS) {
          lowScores(resolveTheme(appearance({ background: bg, myBubble: id, edithBubble: id, glass: glassAmount })), `${bg}/${id ?? 'default'}/${glassAmount}%`, failures);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('gradient bubbles read across the whole gradient on every theme background too', () => {
    const failures: string[] = [];
    for (const p of PRESETS) {
      for (const b of BACKGROUNDS) {
        for (const id of GRADIENT_BUBBLES) {
          for (const glassAmount of [0, 60, 100]) {
            lowScores(resolveTheme(appearance({ theme: p.id, background: b.id, myBubble: id, edithBubble: id, glass: glassAmount })), `${p.id}/${b.id}/${id}/${glassAmount}%`, failures);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('a gradient built with "Custom…" reads, whatever its colours, on any background', () => {
    const failures: string[] = [];
    for (const bg of ['glow', 'dots', 'sunset', 'custom-1', 'custom-2']) {
      for (const g of CUSTOM_BUBBLES) {
        for (const glassAmount of [0, 30, 60, 100]) {
          const t = resolveTheme(appearance({ background: bg, myBubble: 'custom', myGradient: g, edithBubble: 'custom', edithGradient: g, glass: glassAmount }));
          expect(t.my.gradient).not.toBeNull();
          lowScores(t, `${bg}/${g.stops.join('>')}/${glassAmount}%`, failures);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('the default bubble in every accent (and every theme’s) reads on every background', () => {
    const failures: string[] = [];
    const backgrounds = [...BACKGROUNDS.map((b) => b.id), ...GRADIENT_BACKGROUNDS.map((b) => b.id), ...EXTREMES.map((c) => c.id)];
    for (const p of PRESETS) {
      for (const accent of [null, ...ACCENTS.map((a) => a.id)]) {
        for (const bg of backgrounds) {
          for (const glassAmount of [0, 60, 100]) lowScores(resolveTheme(appearance({ theme: p.id, accent, background: bg, glass: glassAmount })), `${p.id}/${accent}/${bg}/${glassAmount}%`, failures);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('a gradient bubble is drawn stop by stop, in its direction, with one alpha for every stop', () => {
    const t = resolveTheme(appearance({ myBubble: 'grad-sunset' }));
    expect(t.my.gradient).toMatchObject(anglePoints(135));
    expect(t.my.gradient!.colors).toHaveLength(2);
    const alphas = t.my.gradient!.colors.map((c) => /, ([\d.]+)\)$/.exec(c)![1]);
    expect(new Set(alphas).size).toBe(1);
    expect(t.my.fill).toBe(t.my.gradient!.colors[0]);
    expect(resolveTheme(appearance({ myBubble: 'teal' })).my.gradient).toBeNull();
  });

  it('picks dark text on a light bubble and light text on a dark one', () => {
    const look = resolveTheme(DEFAULT_APPEARANCE).background;
    expect(bubbleLook('#F2C94C', 1, 60, look).ink).toBe(INK_DARK); // solid yellow
    expect(bubbleLook('#FFFFFF', 0.07, 60, look).ink).toBe(INK_LIGHT); // EDITH's faint pane
    // Black to white, solid: no ink reads all over it, which is why every gradient's strength is fitted.
    expect(bubbleLook(['#000000', '#FFFFFF'], 1, 0, look).worst).toBeLessThan(4.5);
  });

  it('keeps every chosen colour strong enough to read as that colour', () => {
    const weak: string[] = [];
    for (const p of PRESETS) {
      for (const id of [...BACKGROUNDS.map((b) => b.id), ...GRADIENT_BACKGROUNDS.map((b) => b.id)]) {
        const look = backgroundLook(p, id);
        for (const s of SWATCHES) {
          const a = fitBubbleAlpha(s.color, look);
          if (a < 0.3) weak.push(`${p.id}/${id}/${s.id}: ${a}`);
        }
        for (const g of BUBBLE_GRADIENTS) {
          const a = fitBubbleAlpha(g.gradient.stops, look);
          if (a < 0.3) weak.push(`${p.id}/${id}/${g.id}: ${a}`);
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

describe('backgrounds', () => {
  const all = (): { label: string; samples: Rgb[] }[] => [
    ...PRESETS.flatMap((p) => BACKGROUNDS.map((b) => ({ label: `${p.id}/${b.id}`, samples: backdropSamples(backgroundLook(p, b.id)) }))),
    ...GRADIENT_BACKGROUNDS.map((b) => ({ label: b.id, samples: backdropSamples(backgroundLook(PRESETS[0]!, b.id)) })),
    ...EXTREMES.map((c) => ({ label: c.id, samples: backdropSamples(backgroundLook(PRESETS[0]!, c.id, EXTREMES)) })),
  ];

  it('the app’s text and dim text read at 4.5:1 directly on every background, custom extremes included', () => {
    const low = all().flatMap(({ label, samples }) => {
      const s = { text: worst(colors.text, samples), dim: worst(colors.textDim, samples) };
      return Object.entries(s)
        .filter(([, v]) => v < 4.5)
        .map(([k, v]) => `${label}: ${k} ${v.toFixed(2)}`);
    });
    expect(low).toEqual([]);
  });

  it('every accent reads as text on every background, and text on it reads too', () => {
    const accents = [...new Set([...PRESETS.map((p) => p.accent), ...ACCENTS.map((a) => a.color)])];
    const low: string[] = [];
    for (const { label, samples } of all()) for (const a of accents) if (worst(a, samples) < 4.5) low.push(`${label}/${a}: ${worst(a, samples).toFixed(2)}`);
    expect(low).toEqual([]);
    for (const a of ACCENTS) {
      const t = resolveTheme({ ...DEFAULT_APPEARANCE, accent: a.id });
      expect(t.accent).toBe(a.color);
      expect(contrast(rgbOf(t.accentText), rgbOf(t.accent))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('gradient stops are dimmed to the intensity’s cap, keeping their hue', () => {
    for (const i of [0, 50, 100]) {
      const cap = BACKGROUND_LUMINANCE.least + (BACKGROUND_LUMINANCE.most - BACKGROUND_LUMINANCE.least) * (i / 100);
      for (const c of ['#FFFFFF', '#FF7E5F', '#3EECAC', '#FFFF00']) {
        const tamed = tame(c, i);
        expect(luminance(rgbOf(tamed))).toBeLessThanOrEqual(cap + 0.002); // 8-bit rounding
        if (c !== '#FFFFFF') expect(Math.abs(hexToHsv(tamed).h - hexToHsv(c).h)).toBeLessThanOrEqual(6);
      }
    }
    expect(tame('#0B1A2E', 100)).toBe('#0B1A2E'); // dark already: unchanged
  });

  it('about 12–16 gradient presets, linear and radial, some multi-stop, two drifting', () => {
    expect(GRADIENT_BACKGROUNDS.length).toBeGreaterThanOrEqual(12);
    expect(GRADIENT_BACKGROUNDS.length).toBeLessThanOrEqual(16);
    expect(new Set(GRADIENT_BACKGROUNDS.map((b) => b.id)).size).toBe(GRADIENT_BACKGROUNDS.length);
    expect(GRADIENT_BACKGROUNDS.some((b) => b.spec.kind === 'radial')).toBe(true);
    expect(GRADIENT_BACKGROUNDS.some((b) => b.spec.stops.length >= 3)).toBe(true);
    expect(GRADIENT_BACKGROUNDS.filter((b) => b.drift)).toHaveLength(2);
    // No id clashes with the theme-coloured backgrounds.
    expect(GRADIENT_BACKGROUNDS.filter((b) => BACKGROUNDS.some((x) => x.id === b.id))).toEqual([]);
    const sunset = backgroundLook(PRESETS[0]!, 'sunset');
    expect(sunset.layers[0]!.colors).toHaveLength(3);
    expect(luminance(rgbOf(sunset.bg))).toBeLessThanOrEqual(Math.min(...sunset.layers[0]!.colors.map((c) => luminance(rgbOf(c)))));
    expect(backgroundLook(PRESETS[0]!, 'lavender').layers[0]!.kind).toBe('radial');
    expect(backgroundLook(PRESETS[0]!, 'aurora-drift').drift).toBe(true);
  });

  it('the theme’s base under the glass is the background’s', () => {
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, background: 'sunset' }).bg).toBe(backgroundLook(PRESETS[0]!, 'sunset').bg);
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'ocean' }).bg).toBe('#03101A');
  });
});

describe('gradient maths', () => {
  it('an angle goes across the box: 0 upwards, 90 to the right, 135 corner to corner', () => {
    expect(anglePoints(0)).toEqual({ start: { x: 0.5, y: 1 }, end: { x: 0.5, y: 0 } });
    expect(anglePoints(90)).toEqual({ start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } });
    expect(anglePoints(135)).toEqual({ start: { x: 0, y: 0 }, end: { x: 1, y: 1 } });
  });

  it('hue and brightness round-trip', () => {
    for (const c of ['#FF7E5F', '#22A699', '#6C5BD9', '#F9D423']) {
      const { h, s, v } = hexToHsv(c);
      const back = rgbOf(hsvToHex(h, s, v));
      rgbOf(c).forEach((x, i) => expect(Math.abs(x - back[i]!)).toBeLessThan(0.02));
    }
    expect(hsvToHex(0, 1, 1)).toBe('#FF0000');
    expect(hsvToHex(240, 1, 0.5)).toBe('#000080');
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
    expect([t.my.gradient, t.edith.gradient, t.background.drift]).toEqual([null, null, false]);
  });

  it('an accent overrides the theme’s everywhere it shows: the default bubble, the soft fill, the title glow', () => {
    const t = resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'ocean', accent: 'pink' });
    const pink = ACCENTS.find((a) => a.id === 'pink')!.color;
    expect(t.accent).toBe(pink);
    expect(t.accentSoft).toBe(withAlpha(pink, 0.2));
    expect(t.titleGlow).toBe(withAlpha(pink, 0.75));
    expect(rgbOf(t.my.fill).map((v) => Math.round(v * 255))).toEqual(rgbOf(pink).map((v) => Math.round(v * 255)));
  });

  it('a swatch’s check mark reads at 3:1 or more on every swatch and gradient, the theme-default ones included', () => {
    const low: string[] = [];
    for (const p of PRESETS) {
      const solid = [...SWATCHES.map((s) => s.color), ...ACCENTS.map((a) => a.color), withAlpha(p.accent, 0.35), withAlpha('#FFFFFF', 0.35)].map((c) => [c]);
      const gradients = BUBBLE_GRADIENTS.map((g) => [...g.gradient.stops]);
      for (const stops of [...solid, ...gradients]) {
        const mark = rgbOf(inkOn(stops, p.bg));
        const each = stops.map((c) => composite(c, rgbOf(p.bg)));
        const under = each.flatMap((c, i) => (i === 0 ? [c] : [mixed(each[i - 1]!, c, 0.5), c]));
        const ratio = Math.min(...under.map((u) => contrast(mark, u)));
        if (ratio < 3) low.push(`${p.id}/${stops.join('>')}: ${ratio.toFixed(2)}`);
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
    expect(new Set(ACCENTS.map((a) => a.color)).size).toBe(ACCENTS.length);
  });
});

describe('a photo background', () => {
  const grid = (...colours: Rgb[]): Rgb[] => Array.from({ length: 12 * 24 }, (_, i) => colours[i % colours.length]!);
  const photo = (name: string, pixels: Rgb[]): Photo => ({ uri: `file:///docs/wallpapers/${name}.jpg`, width: 1080, height: 1440, tones: photoTones(pixels) });
  /** The worst pictures for text: all white, bright and saturated patches, mid grey, black, and unreadable colours. */
  const PHOTOS: Photo[] = [
    photo('white', grid([1, 1, 1])),
    photo('sunlit', grid([1, 1, 0.6], [0.4, 0.9, 1], [1, 1, 1], [0.1, 0.1, 0.12], [0.9, 0.6, 0.2])),
    photo('saturated', grid([1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0])),
    photo('grey', grid([0.5, 0.5, 0.5])),
    photo('black', grid([0, 0, 0])),
    { uri: 'file:///docs/wallpapers/unknown.jpg', width: 800, height: 600, tones: [...UNKNOWN_TONES] },
  ];
  const on = (p: Photo, adjust: Partial<PhotoBackground> = {}, a: Partial<Appearance> = {}): Appearance =>
    appearance({ photos: PHOTOS, background: { kind: 'photo', uri: p.uri, blur: 4, dim: 35, focus: 'center', tint: false, ...adjust }, ...a });

  it('the shades are laid over the photo’s colours: black at the dim, then the theme’s tint', () => {
    const p = PHOTOS[1]!;
    const t = resolveTheme(on(p, { dim: 80, tint: true }, { theme: 'rose' }));
    expect(t.background.photo).toMatchObject({ uri: p.uri, blur: 4, focus: 'center' });
    const dim = t.background.photo!.dim; // the rose tint lightens it: dimmed a step further (85%)
    expect(dim).toBeGreaterThanOrEqual(80);
    const expected = p.tones.map((hex) => composite(withAlpha(PRESETS.find((x) => x.id === 'rose')!.glow, 0.2), composite(`rgba(0, 0, 0, ${dim / 100})`, rgbOf(hex))));
    const samples = backdropSamples(t.background);
    for (const e of expected) expect(samples.some((s) => s.every((v, i) => Math.abs(v - e[i]!) < 1e-6))).toBe(true);
    expect(t.bg).toBe(t.background.bg); // the frost's base: the dimmed mean
  });

  it('the app’s text, dim text and accent read at 4.5:1 on any photo: a bright one is dimmed further, and says so', () => {
    const low: string[] = [];
    for (const pr of PRESETS) {
      for (const p of PHOTOS) {
        for (const dim of [0, 35, 80]) {
          for (const tint of [false, true]) {
            for (const accent of [null, ...ACCENTS.map((a) => a.id)]) {
              const t = resolveTheme(on(p, { dim, tint }, { theme: pr.id, accent }));
              const samples = backdropSamples(t.background);
              for (const [k, c] of [['text', colors.text], ['dim', colors.textDim], ['accent', t.accent]] as const) {
                if (worst(c, samples) < 4.5) low.push(`${pr.id}/${p.uri}/${dim}/${tint}/${accent}: ${k} ${worst(c, samples).toFixed(2)}`);
              }
            }
          }
        }
      }
    }
    expect(low).toEqual([]);
    const white = resolveTheme(on(PHOTOS[0]!, { dim: 0 })).background.photo!;
    expect(white.raised).toBe(true);
    expect(white.dim).toBeGreaterThan(0);
    expect(white.dim).toBeLessThanOrEqual(PHOTO_DIM_LIMIT);
    expect(resolveTheme(on(PHOTOS[4]!, { dim: 10 })).background.photo).toMatchObject({ dim: 10, raised: false }); // black: as chosen
    // Unknown colours are taken as white: dimmed as much.
    expect(resolveTheme(on(PHOTOS[5]!, { dim: 0 })).background.photo!.dim).toBe(white.dim);
  });

  it('chat text reads at 4.5:1 or more on every photo: each preset × colour and gradient bubble × dim × tint × glass, quotes included', () => {
    const failures: string[] = [];
    for (const pr of PRESETS) {
      for (const p of PHOTOS) {
        for (const dim of [0, 35, 80]) {
          for (const tint of [false, true]) {
            for (const id of [...COLOURS, ...GRADIENT_BUBBLES.slice(0, 3)]) {
              for (const glassAmount of [0, 30, 60, 100]) {
                lowScores(resolveTheme(on(p, { dim, tint }, { theme: pr.id, myBubble: id, edithBubble: id, glass: glassAmount })), `${pr.id}/${p.uri}/${dim}/${tint}/${id ?? 'default'}/${glassAmount}%`, failures);
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('a photo’s tones: the mean first, then the brightest and darkest patches; nothing read is taken as white', () => {
    const tones = photoTones([[1, 1, 1], [0, 0, 0], [0.5, 0.5, 0.5], [1, 0, 0]]);
    expect(tones[0]).toBe('#9F6060'); // the mean of the four: (2.5, 1.5, 1.5) / 4
    expect(tones).toEqual(expect.arrayContaining(['#FFFFFF', '#000000', '#FF0000']));
    expect(photoTones([])).toEqual(['#FFFFFF']);
    expect(photoTones(Array.from({ length: 300 }, (_, i) => [i / 300, i / 300, i / 300] as Rgb)).length).toBeLessThanOrEqual(10);
  });

  it('covers the screen with the cut axis at its focus', () => {
    // A wide photo on a tall screen: its sides are cut.
    expect(cutAxis(400, 800, 1440, 960)).toBe('horizontal');
    expect(coverRect(400, 800, 1440, 960, 'start')).toEqual({ left: 0, top: 0, width: 1200, height: 800 });
    expect(coverRect(400, 800, 1440, 960, 'center')).toEqual({ left: -400, top: 0, width: 1200, height: 800 });
    expect(coverRect(400, 800, 1440, 960, 'end')).toEqual({ left: -800, top: 0, width: 1200, height: 800 });
    // A tall photo, taller than the screen: top and bottom are cut.
    expect(cutAxis(400, 800, 1000, 3000)).toBe('vertical');
    expect(coverRect(400, 800, 1000, 3000, 'end')).toEqual({ left: 0, top: -400, width: 400, height: 1200 });
  });

  it('is stored whole: kept photos and the photo background made valid; one pointing at no kept photo falls back', () => {
    const kept = { uri: 'file:///docs/wallpapers/1.jpg', width: 1080, height: 1440, tones: ['#102030', 'nope', '#FFFFFF'] };
    const a = normalizeAppearance({
      photos: [kept, { ...kept }, { uri: '', width: 1, height: 1 }, { uri: 'x', width: -1, height: 2 }, null, { uri: 'file:///b.jpg', width: 10, height: 10 }, { uri: 'c', width: 1, height: 1 }, { uri: 'd', width: 1, height: 1 }],
      background: { kind: 'photo', uri: kept.uri, blur: 99, dim: -5, focus: 'sideways', tint: 'yes' },
    });
    expect(a.photos).toEqual([
      { ...kept, tones: ['#102030', '#FFFFFF'] },
      { uri: 'file:///b.jpg', width: 10, height: 10, tones: ['#FFFFFF'] }, // no colours: assumed white
      { uri: 'c', width: 1, height: 1, tones: ['#FFFFFF'] },
    ]);
    expect(a.photos).toHaveLength(MAX_PHOTOS);
    expect(a.background).toEqual({ kind: 'photo', uri: kept.uri, blur: 20, dim: 0, focus: 'center', tint: false });
    expect(normalizeAppearance({ photos: [kept], background: { kind: 'photo', uri: 'file:///gone.jpg' } }).background).toBe('glow');
    expect(normalizeAppearance({ background: { kind: 'gif', uri: kept.uri } }).background).toBe('glow');
    expect(resolveTheme({ ...DEFAULT_APPEARANCE, background: { kind: 'photo', uri: 'x', blur: 0, dim: 0, focus: 'center', tint: false } }).background.id).toBe('glow'); // never crashes
  });
});

describe('a stored appearance', () => {
  it('is made whole and valid', () => {
    expect(normalizeAppearance(null)).toEqual(DEFAULT_APPEARANCE);
    expect(normalizeAppearance({ theme: 'nope', myBubble: 'teal', edithBubble: 'mauve', background: 'grid', glass: 140 })).toEqual({
      ...DEFAULT_APPEARANCE,
      myBubble: 'teal',
      background: 'grid',
      glass: 100,
    });
    expect(normalizeAppearance({ glass: -3.4 }).glass).toBe(0);
  });

  it('from before gradients (appearance.v1 as first shipped) keeps every choice, the new ones at their defaults', () => {
    const old = { theme: 'rose', myBubble: 'yellow', edithBubble: null, background: 'dots', glass: 35 };
    expect(normalizeAppearance(JSON.parse(JSON.stringify(old)))).toEqual({ ...DEFAULT_APPEARANCE, ...old });
  });

  it('keeps valid gradients and drops broken ones; a choice pointing at nothing falls back', () => {
    const good = { id: 'custom-4', stops: ['#ff0000', '#00FF00', '#0000FF'], angle: 400, kind: 'radial', intensity: 140 };
    const a = normalizeAppearance({
      background: 'custom-4',
      customGradients: [good, { id: 'custom-5', stops: ['#FF0000'] }, { id: 'nope', stops: ['#FF0000', '#00FF00'] }, { ...good }, null, 'x'],
      myBubble: 'custom',
      myGradient: { stops: ['#FF0000', 'red'], angle: 10 }, // one good stop: no gradient
      edithBubble: 'custom',
      edithGradient: { stops: ['#E07BC4', '#9B7CF0', '#000000'], angle: -45 },
      accent: 'teal',
    });
    expect(a.customGradients).toEqual([{ id: 'custom-4', stops: ['#FF0000', '#00FF00', '#0000FF'], angle: 40, kind: 'radial', intensity: 100 }]);
    expect(a.background).toBe('custom-4');
    expect([a.myBubble, a.myGradient]).toEqual([null, null]);
    expect([a.edithBubble, a.edithGradient]).toEqual(['custom', { stops: ['#E07BC4', '#9B7CF0'], angle: 315 }]);
    expect(a.accent).toBe('teal');
    expect(normalizeAppearance({ background: 'custom-9' }).background).toBe('glow'); // deleted
    expect(normalizeAppearance({ accent: 'mauve', myBubble: 'grad-neon' })).toMatchObject({ accent: null, myBubble: 'grad-neon' });
    expect(normalizeAppearance({ background: 'sunset' }).background).toBe('sunset');
  });

  it(`keeps at most ${MAX_CUSTOM} custom gradients, with fresh ids`, () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `custom-${i + 1}`, stops: ['#FF0000', '#0000FF'], angle: 0, kind: 'linear', intensity: 50 }));
    const a = normalizeAppearance({ customGradients: many });
    expect(a.customGradients).toHaveLength(MAX_CUSTOM);
    expect(nextCustomId(a.customGradients)).toBe('custom-7');
    expect(nextCustomId([])).toBe('custom-1');
    expect(nextCustomId(a.customGradients.filter((c) => c.id !== 'custom-2'))).toBe('custom-7');
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
