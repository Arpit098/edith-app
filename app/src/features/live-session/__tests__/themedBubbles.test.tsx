// The chat's bubbles in the active theme: each side's glass tint and edge, its ink for the text, the
// captions and the quote (on its own pane), no extra view and no clipping per bubble (cheap in long
// lists), and a theme change re-renders them at once.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';

import { DEFAULT_APPEARANCE, resolveTheme, ThemeContext, type Theme } from '../../../core/theme';
import { ItemView } from '../ItemView';

jest.setTimeout(30_000);

const USER = {
  id: 1, ts: 1_800_000_000, kind: 'user', text: 'Ship it', origin: 'app', voice: true, ref: 'r', delivery: null, local: null, echoed: true, reaction: null,
  attachments: [], replyTo: { from: 'edith', text: 'The build passed.' },
} as const;
const EDITH = { id: 2, ts: 1_800_000_000, kind: 'assistant', text: 'Done.', lane: null, ref: null } as const;

function render(theme: Theme): ReactTestRenderer {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      <ThemeContext.Provider value={theme}>
        <ItemView item={USER as never} onPress={async () => null} tick="delivered" />
        <ItemView item={EDITH as never} onPress={async () => null} />
      </ThemeContext.Provider>,
    );
  });
  return r;
}

const style = (n: ReactTestInstance) => StyleSheet.flatten(n.props.style);
const textOf = (r: ReactTestRenderer, words: string) => r.root.findAllByType(Text).find((t) => [t.props.children].flat().join('') === words)!;
/** The bubble around some text: the nearest ancestor with a background. */
function bubbleAround(n: ReactTestInstance): ReactTestInstance {
  let p = n.parent;
  while (p && !style(p)?.backgroundColor) p = p.parent;
  return p!;
}
const gradients = (n: ReactTestInstance) => n.findAll((x) => Array.isArray(x.props.colors));

afterEach(() => jest.restoreAllMocks());

describe('chat bubbles in the theme', () => {
  it('take each side’s glass and ink, the quote on its pane in its own fade', () => {
    const t = resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'rose', myBubble: 'yellow', edithBubble: 'blue' });
    const r = render(t);
    const mine = bubbleAround(textOf(r, 'Ship it'));
    // The edge in one colour all round: per-side colours broke off at two corners.
    expect(style(mine)).toMatchObject({ backgroundColor: t.my.fill, borderTopColor: t.my.edge, borderRightColor: t.my.edge, borderBottomColor: t.my.edge, borderLeftColor: t.my.edge });
    expect(style(textOf(r, 'Ship it')).color).toBe(t.my.ink);
    expect(style(textOf(r, '🎙 voice')).color).toBe(t.my.inkDim); // captions in the bubble's own ink
    expect(style(textOf(r, 'The build passed.')).color).toBe(t.my.quoteDim);
    expect(style(bubbleAround(textOf(r, 'The build passed.'))).backgroundColor).toBe(t.my.inkSoft);
    const hers = bubbleAround(textOf(r, 'Done.'));
    expect(style(hers).backgroundColor).toBe(t.edith.fill);
    expect(style(textOf(r, 'Done.')).color).toBe(t.edith.ink);
    // The sheen is the lit top edge: no gradient view and no clipping per bubble.
    for (const b of [mine, hers]) {
      expect(gradients(b)).toHaveLength(0);
      expect(style(b).overflow).toBeUndefined();
    }
  });

  it('are solid at 0% glass, and follow a theme change at once', () => {
    const flat = resolveTheme({ ...DEFAULT_APPEARANCE, glass: 0 });
    const r = render(flat);
    expect(style(bubbleAround(textOf(r, 'Ship it'))).backgroundColor).toMatch(/, 1\)$/);
    const ocean = resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'ocean' });
    act(() =>
      r.update(
        <ThemeContext.Provider value={ocean}>
          <ItemView item={USER as never} onPress={async () => null} tick="delivered" />
        </ThemeContext.Provider>,
      ),
    );
    expect(style(bubbleAround(textOf(r, 'Ship it'))).backgroundColor).toBe(ocean.my.fill);
  });

  it('a gradient bubble adds just its fill, in the bubble’s shape, with no clipping; the other side adds nothing', () => {
    const t = resolveTheme({ ...DEFAULT_APPEARANCE, myBubble: 'grad-aurora', edithBubble: 'custom', edithGradient: { stops: ['#E07BC4', '#3D7FD9'], angle: 90 } });
    const r = render(t);
    const mine = bubbleAround(textOf(r, 'Ship it'));
    expect(style(mine).backgroundColor).toBe('transparent'); // the fill is the tint
    expect(style(mine).overflow).toBeUndefined();
    const [fill] = gradients(mine);
    expect(fill!.props.colors).toEqual(t.my.gradient!.colors);
    expect([fill!.props.start, fill!.props.end]).toEqual([t.my.gradient!.start, t.my.gradient!.end]);
    // Inside the 1dp edge: the bubble's radii less 1, its small corner bottom-right.
    expect(style(fill!)).toMatchObject({ position: 'absolute', borderTopLeftRadius: 21, borderBottomRightRadius: 7, borderBottomLeftRadius: 21 });
    expect(style(textOf(r, 'Ship it')).color).toBe(t.my.ink);
    expect(style(textOf(r, 'The build passed.')).color).toBe(t.my.quoteDim);
    const hers = bubbleAround(textOf(r, 'Done.'));
    expect(style(gradients(hers)[0]!)).toMatchObject({ borderBottomLeftRadius: 7, borderBottomRightRadius: 21 });
    // One colour: no fill view at all.
    const plain = render(resolveTheme({ ...DEFAULT_APPEARANCE, myBubble: 'teal' }));
    expect(gradients(bubbleAround(textOf(plain, 'Ship it')))).toHaveLength(0);
  });
});
