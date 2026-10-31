// The gradient title: a header by its label, its letters filled with the theme's gradient (left to
// right, in titleGradient's order) over a faint glow drawn from the same text, all centred.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { LinearGradient, Stop, Text as SvgText } from 'react-native-svg';

import { titleGradient } from '../../core/theme';
import { GradientTitle, MAX_TITLE_SCALE, titleScale } from '../GradientTitle';

it('fills the title with the theme gradient over its glow, centred', () => {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<GradientTitle text="E.D.I.T.H" fontSize={22} letterSpacing={1.5} />);
  });
  expect(r.root.findAll((n) => n.props?.accessibilityRole === 'header' && n.props.accessibilityLabel === 'E.D.I.T.H')).not.toHaveLength(0);

  const gradient = r.root.findByType(LinearGradient);
  expect([gradient.props.x1, gradient.props.x2, gradient.props.y1, gradient.props.y2]).toEqual(['0', '1', '0', '0']); // left to right
  expect(r.root.findAllByType(Stop).map((s) => s.props.stopColor)).toEqual([...titleGradient]);

  const layers = r.root.findAllByType(SvgText);
  expect(layers.every((l) => l.props.children === 'E.D.I.T.H' && l.props.textAnchor === 'middle' && l.props.x === '50%')).toBe(true);
  const fill = layers[layers.length - 1]!; // drawn last: on top of the glow
  expect(fill.props.fill).toBe(`url(#${gradient.props.id})`);
  expect(layers.slice(0, -1).every((l) => l.props.fill === 'none' && l.props.strokeOpacity < 0.5)).toBe(true); // the glow: faint strokes
  act(() => r.unmount());
});

it('follows the system font size, capped so the title fits between the header insets', () => {
  const { PixelRatio } = jest.requireActual<typeof import('react-native')>('react-native');
  expect(titleScale(1)).toBe(1);
  expect(titleScale(1.15)).toBe(1.15);
  expect(titleScale(2)).toBe(MAX_TITLE_SCALE);
  expect(titleScale(0.85)).toBe(1); // never smaller than designed
  const spy = jest.spyOn(PixelRatio, 'getFontScale').mockReturnValue(2);
  let r!: ReactTestRenderer;
  act(() => {
    r = create(<GradientTitle text="E.D.I.T.H" fontSize={20} />);
  });
  expect(r.root.findAllByType(SvgText).every((l) => Math.abs(l.props.fontSize - 20 * MAX_TITLE_SCALE) < 1e-9)).toBe(true);
  act(() => r.unmount());
  spy.mockRestore();
});
