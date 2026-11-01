// A photo backdrop: one Image covering the box at the photo's focus, blurred once (blurRadius), the
// dim drawn over it; nothing moves; a thumbnail decodes small with its blur scaled down; a file that
// can't be read leaves the dimmed mean showing instead of crashing.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Dimensions, Image, StyleSheet } from 'react-native';

import { DEFAULT_APPEARANCE, PRESETS, photoLook, resolveTheme, ThemeContext, type Appearance, type Photo } from '../../core/theme';
import { Ambient } from '../Ambient';

const PHOTO: Photo = { uri: 'file:///docs/wallpapers/1.jpg', width: 1440, height: 960, tones: ['#203040'] };
const APPEARANCE: Appearance = { ...DEFAULT_APPEARANCE, photos: [PHOTO], background: { kind: 'photo', uri: PHOTO.uri, blur: 12, dim: 40, focus: 'end', tint: false } };

function render(el: React.ReactElement): ReactTestRenderer {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<ThemeContext.Provider value={resolveTheme(APPEARANCE)}>{el}</ThemeContext.Provider>);
  });
  return r;
}
const layout = (r: ReactTestRenderer, width: number, height: number) =>
  act(() => r.root.find((n) => n.props.testID === 'ambient-photo-layer' && n.props.onLayout).props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));

afterEach(() => jest.restoreAllMocks());

describe('a photo backdrop', () => {
  it('covers the screen with the cut side at its focus, blurred once, dimmed over', () => {
    const r = render(<Ambient />);
    expect(r.root.findAllByType(Image)).toHaveLength(0); // drawn once its box is known
    layout(r, 400, 800);
    const img = r.root.findByType(Image);
    expect(img.props.source).toEqual({ uri: PHOTO.uri });
    expect(img.props.blurRadius).toBe(12);
    expect(img.props.fadeDuration).toBe(0);
    expect(StyleSheet.flatten(img.props.style)).toMatchObject({ position: 'absolute', left: -800, top: 0, width: 1200, height: 800 }); // 'end': the right side
    const dim = r.root.findAll((n) => Array.isArray(n.props.colors) && n.props.colors[0] === 'rgba(0, 0, 0, 0.4)');
    expect(dim.length).toBeGreaterThan(0);
    expect(r.root.findAll((n) => n.props.testID === 'ambient-drift')).toHaveLength(0);
  });

  it('a thumbnail decodes small with its blur scaled to its size', () => {
    const look = photoLook(PRESETS[0]!, PHOTO, APPEARANCE.background as never);
    const r = render(<Ambient look={look} />);
    layout(r, 64, 64);
    const img = r.root.findByType(Image);
    expect(img.props.resizeMethod).toBe('resize');
    expect(img.props.blurRadius).toBeCloseTo((12 * 64) / Dimensions.get('window').width);
  });

  it('a file that can’t be read draws nothing over the dimmed mean', () => {
    const r = render(<Ambient />);
    layout(r, 400, 800);
    act(() => r.root.findByType(Image).props.onError({ nativeEvent: { error: 'gone' } }));
    expect(r.root.findAllByType(Image)).toHaveLength(0);
    const base = r.root.find((n) => n.props.testID === 'ambient-photo' && n.props.pointerEvents === 'none');
    expect(StyleSheet.flatten(base.props.style).backgroundColor).toBe(resolveTheme(APPEARANCE).bg);
  });
});
