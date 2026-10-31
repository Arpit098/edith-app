// The glass amount on every Glass surface: at 0% no native lens or blur and no rim (the flat,
// near-solid pane); at 60% the original look; above, more blur and bend with a rim no wider. And the
// backdrop draws the chosen background; themed sheets are built once per theme.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, View } from 'react-native';

import { DEFAULT_APPEARANCE, glass, GlassContext, resolveTheme, themedStyles, ThemeContext, useTheme, type NativeGlassProps, type Theme } from '../../core/theme';
import { Ambient } from '../Ambient';
import { Glass } from '../Glass';

function FakeNative(_: NativeGlassProps) {
  return null;
}

function render(node: React.ReactElement, theme: Theme): ReactTestRenderer {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <ThemeContext.Provider value={theme}>
        <GlassContext.Provider value={{ mode: 'shader', View: FakeNative, reduceMotion: false }}>{node}</GlassContext.Provider>
      </ThemeContext.Provider>,
    );
  });
  return r;
}

const at = (glassAmount: number) => resolveTheme({ ...DEFAULT_APPEARANCE, glass: glassAmount });
const native = (r: ReactTestRenderer) => r.root.findAllByType(FakeNative).map((n) => n.props as NativeGlassProps);
const layout = (r: ReactTestRenderer) => act(() => r.root.findAllByType(View)[0]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 80, height: 40 } } }));
const rimProps = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.props.strength === 'number' && n.props.width !== undefined, { deep: false }).map((n) => n.props);

afterEach(() => jest.restoreAllMocks());

describe('the glass amount on Glass', () => {
  it('0%: flat and near-solid, no lens, no rim', () => {
    const r = render(<Glass level="regular" backdrop={7} rim />, at(0));
    expect(native(r)).toHaveLength(0);
    expect(StyleSheet.flatten(r.root.findAllByType(View)[0]!.props.style).backgroundColor).toMatch(/0\.98\)$/);
    layout(r);
    expect(rimProps(r)[0]?.strength).toBe(0); // the Rim draws nothing at 0
  });

  it('60%: the original look; 100%: more blur and bend, the rim no wider', () => {
    const r60 = render(<Glass level="regular" backdrop={7} rim />, at(60));
    expect(native(r60)[0]).toMatchObject({ blur: glass.regular.blur, refraction: glass.regular.refraction, rimWidth: glass.regular.rimWidth });
    const r100 = render(<Glass level="regular" backdrop={7} rim />, at(100));
    const n = native(r100)[0]!;
    expect(n.blur).toBeGreaterThan(glass.regular.blur);
    expect(n.refraction).toBeGreaterThan(glass.regular.refraction);
    expect(n.rimWidth).toBe(glass.regular.rimWidth);
    expect(n.base.slice(0, 3)).toEqual([5 / 255, 7 / 255, 10 / 255]); // the theme's background under the frost
    layout(r100);
    expect(rimProps(r100)[0]?.strength).toBe(1);
  });
});

describe('the backdrop', () => {
  it('draws the chosen background in the theme’s colours', () => {
    for (const background of ['glow', 'plain', 'sweep', 'horizon', 'dots', 'grid'] as const) {
      const t = resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'forest', background });
      const r = render(<Ambient />, t);
      const root = r.root.find((n) => n.props.testID === `ambient-${background}`);
      expect(StyleSheet.flatten(root.props.style).backgroundColor).toBe(t.bg);
      expect(root.findAll((n) => Array.isArray(n.props.colors), { deep: false }).length).toBe(t.background.layers.length);
    }
  });
});

describe('themedStyles', () => {
  it('builds a sheet once per theme', () => {
    const make = jest.fn((t: Theme) => ({ box: { backgroundColor: t.accent } }));
    const useStyles = themedStyles(make);
    const seen: string[] = [];
    function Probe() {
      useTheme();
      seen.push(useStyles().box.backgroundColor);
      return null;
    }
    const a = at(60);
    const r = render(<Probe />, a);
    act(() => r.update(<ThemeContext.Provider value={a}><Probe /></ThemeContext.Provider>));
    expect(make).toHaveBeenCalledTimes(1);
    const rose = resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'rose' });
    act(() => r.update(<ThemeContext.Provider value={rose}><Probe /></ThemeContext.Provider>));
    expect(make).toHaveBeenCalledTimes(2);
    expect(seen.at(-1)).toBe(rose.accent);
  });
});
