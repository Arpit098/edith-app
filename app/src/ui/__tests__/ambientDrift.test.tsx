// A drifting background pauses while real glass samples it, and moves again at 0%: the same views
// either way. It used to swap its first layer between two components, which remounted it (a flash on
// the backdrop, and every glass pane over it, whenever glass crossed 0%).

import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { DEFAULT_APPEARANCE, GlassContext, resolveTheme, ThemeContext, type Theme } from '../../core/theme';
import { Ambient } from '../Ambient';

jest.setTimeout(30_000); // the first run transforms React Native

const glass = { mode: 'shader' as const, View: (() => null) as never, reduceMotion: false };

function render(theme: Theme) {
  return (
    <GlassContext.Provider value={glass}>
      <ThemeContext.Provider value={theme}>
        <Ambient />
      </ThemeContext.Provider>
    </GlassContext.Provider>
  );
}

it('pausing and resuming drift keeps the layer mounted: only the animation stops and starts', () => {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  const with60 = resolveTheme({ ...DEFAULT_APPEARANCE, background: 'nebula-drift', glass: 60 });
  const with0 = resolveTheme({ ...DEFAULT_APPEARANCE, background: 'nebula-drift', glass: 0 });
  let r!: ReactTestRenderer;
  act(() => {
    r = create(render(with60));
  });
  const gradientId = () => r.root.findAll((n) => typeof n.props.id === 'string' && n.props.id.startsWith('r'))[0]!.props.id as string;
  const state = () => r.root.findAll((n) => n.props.testID === 'ambient-drift' || n.props.testID === 'ambient-still').map((n) => n.props.testID as string)[0];
  const id = gradientId(); // useId: a remounted layer would get a new one
  expect(state()).toBe('ambient-still'); // real glass over it: held still
  act(() => r.update(render(with0)));
  expect(state()).toBe('ambient-drift'); // flat: it moves
  expect(gradientId()).toBe(id);
  act(() => r.update(render(with60)));
  expect(state()).toBe('ambient-still');
  expect(gradientId()).toBe(id);
  act(() => r.unmount());
});
