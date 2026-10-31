// The chat's bubbles in the active theme: each side's glass tint and edge, its ink for the text and
// the captions, the sheen only above 0% glass, and a theme change re-renders them at once.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text } from 'react-native';

import { DEFAULT_APPEARANCE, resolveTheme, ThemeContext, type Theme } from '../../../core/theme';
import { ItemView } from '../ItemView';

jest.setTimeout(30_000);

const USER = { id: 1, ts: 1_800_000_000, kind: 'user', text: 'Ship it', origin: 'app', voice: true, ref: 'r', delivery: null, local: null, echoed: true, reaction: null, attachments: [], replyTo: null } as const;
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
const sheens = (n: ReactTestInstance) => n.findAll((x) => Array.isArray(x.props.colors) && x.props.pointerEvents === 'none', { deep: false });

afterEach(() => jest.restoreAllMocks());

describe('chat bubbles in the theme', () => {
  it('take each side’s glass and ink', () => {
    const t = resolveTheme({ ...DEFAULT_APPEARANCE, theme: 'rose', myBubble: 'yellow', edithBubble: 'blue' });
    const r = render(t);
    const mine = bubbleAround(textOf(r, 'Ship it'));
    expect(style(mine)).toMatchObject({ backgroundColor: t.my.fill, borderTopColor: t.my.edgeLit, borderBottomColor: t.my.edgeDim });
    expect(style(textOf(r, 'Ship it')).color).toBe(t.my.ink);
    expect(style(textOf(r, '🎙 voice')).color).toBe(t.my.inkDim); // captions in the bubble's own ink
    const hers = bubbleAround(textOf(r, 'Done.'));
    expect(style(hers).backgroundColor).toBe(t.edith.fill);
    expect(style(textOf(r, 'Done.')).color).toBe(t.edith.ink);
    expect(sheens(mine)).toHaveLength(1);
  });

  it('are solid with no sheen at 0% glass, and follow a theme change at once', () => {
    const flat = resolveTheme({ ...DEFAULT_APPEARANCE, glass: 0 });
    const r = render(flat);
    const mine = bubbleAround(textOf(r, 'Ship it'));
    expect(style(mine).backgroundColor).toMatch(/, 1\)$/);
    expect(sheens(mine)).toHaveLength(0);
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
});
