// The composer: three glass pieces with the rim (menu, message pill with the mic, send), the same
// send and voice behaviour as before, and the menu above the left button (attachments, Record and
// the server's commands), which closes on a tap outside and on back.

import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { BackHandler, Text, TextInput } from 'react-native';

import type { Command } from '../../../core/api';
import { createStore } from '../../../core/store';
import { ChromeContext, GlassContext } from '../../../core/theme';
import type { AttachmentsModel, DraftsState } from '../attachments';
import { CLOSE_LABEL, MENU_LABEL } from '../ComposerMenu';
import { toast } from '../../../ui/toast';
import { LiveScreen } from '../LiveScreen';
import { initialLive, type LiveModel } from '../model';
import type { VoiceModel, VoiceState } from '../voice';

jest.setTimeout(30_000); // the first run transforms all of React Native: slow on a cold cache
jest.mock('../../../ui/toast', () => ({ toast: jest.fn() }));

const COMMANDS: Command[] = [
  { name: 'compact', description: 'Compact the context', usage: '', help: '' },
  { name: 'remind', description: 'Set a reminder', usage: '<when> <what>', help: '' },
];

function fakes({ canTalk = true }: { canTalk?: boolean } = {}) {
  const model = {
    store: createStore(initialLive),
    send: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue('Stopped'),
    retry: jest.fn(),
    press: jest.fn(),
    loadOlder: jest.fn().mockResolvedValue(undefined),
    details: jest.fn(),
    commands: jest.fn().mockResolvedValue(COMMANDS),
    dispose: jest.fn(),
  };
  const voiceStore = createStore<VoiceState>({ available: canTalk, phase: 'idle', elapsedMs: 0, level: 0, error: null, autoSend: false });
  const voice = { store: voiceStore, start: jest.fn().mockResolvedValue(undefined), stop: jest.fn().mockResolvedValue(null), cancel: jest.fn() };
  const attachStore = createStore<DraftsState>({ drafts: [], picking: false, error: null });
  const attach = { store: attachStore, add: jest.fn().mockResolvedValue(undefined), retry: jest.fn(), remove: jest.fn(), take: jest.fn(() => []), busy: () => false, dispose: jest.fn() };
  return { model, voice, attach, voiceStore };
}

let backHandlers: (() => boolean)[] = [];

function render(f: ReturnType<typeof fakes>): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = create(
      // Remove animations on: the menu opens and closes at once (the springs are tested in ui/motion).
      <GlassContext.Provider value={{ mode: 'flat', View: null, reduceMotion: true }}>
        <LiveScreen model={f.model as unknown as LiveModel} voice={f.voice as unknown as VoiceModel} attach={f.attach as unknown as AttachmentsModel} />
      </GlassContext.Provider>,
    );
  });
  return r;
}

const byLabel = (r: ReactTestRenderer, label: string): ReactTestInstance[] =>
  r.root.findAll((n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function', { deep: false });
const press = (r: ReactTestRenderer, label: string) => {
  const [n] = byLabel(r, label);
  if (!n) throw new Error(`nothing labelled "${label}"`);
  act(() => n.props.onPress());
};
const labels = (r: ReactTestRenderer, role: string) =>
  r.root.findAll((n) => n.props.accessibilityRole === role && typeof n.props.onPress === 'function', { deep: false }).map((n) => n.props.accessibilityLabel as string);
// Glass surfaces (a memo component: matched by its props, outermost only).
const glassIn = (r: ReactTestRenderer | ReactTestInstance) =>
  ('root' in r ? r.root : r).findAll((n) => typeof n.props.level === 'string' && 'rim' in n.props, { deep: false });
const texts = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).filter((c) => typeof c === 'string').join(''))
    .join(' | ');
const input = (r: ReactTestRenderer) => r.root.findByType(TextInput);
const menuOpen = (r: ReactTestRenderer) => labels(r, 'menuitem').length > 0;

beforeEach(() => {
  jest.useFakeTimers(); // the status pill's clock
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  backHandlers = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_, h) => {
    backHandlers.push(h as () => boolean);
    return { remove: () => (backHandlers = backHandlers.filter((x) => x !== h)) };
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Composer', () => {
  it('is three glass pieces with the rim: the menu button, the message pill with the mic, and send', () => {
    const r = render(fakes());
    const pieces = glassIn(r).filter((g) => g.props.rim);
    expect(pieces).toHaveLength(3);
    expect(pieces.map((g) => g.props.radius)).toEqual([24, 24, 24]); // round, round-ended pill, round
    expect(byLabel(r, MENU_LABEL)).toHaveLength(1);
    expect(byLabel(r, 'Talk to EDITH')).toHaveLength(1);
    expect(byLabel(r, 'Send')[0]!.props.accessibilityState).toMatchObject({ disabled: true }); // nothing to send yet
    // The mic is inside the pill, next to the text box.
    const pill = pieces[1]!;
    expect(pill.findAllByType(TextInput)).toHaveLength(1);
    expect(pill.findAll((n) => n.props.accessibilityLabel === 'Talk to EDITH')).not.toHaveLength(0);
  });

  it('sends what is typed, and talks with the mic', () => {
    const f = fakes();
    const r = render(f);
    act(() => input(r).props.onChangeText('run the tests'));
    expect(byLabel(r, 'Send')[0]!.props.accessibilityState).toMatchObject({ disabled: false });
    press(r, 'Send');
    expect(f.model.send).toHaveBeenCalledWith('run the tests', { voice: false, attachments: [] });
    expect(input(r).props.value).toBe('');
    press(r, 'Talk to EDITH');
    expect(f.voice.start).toHaveBeenCalled();
  });

  it('shows Stop in the pill while EDITH works', async () => {
    const f = fakes();
    const r = render(f);
    expect(byLabel(r, 'Stop')).toHaveLength(0);
    act(() => f.model.store.set((s) => ({ ...s, main: 'busy' })));
    expect(byLabel(r, 'Stop')).toHaveLength(1);
    expect(byLabel(r, 'Talk to EDITH')).toHaveLength(1); // the mic stays
    await act(async () => press(r, 'Stop'));
    expect(f.model.stop).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Stopped');
  });
});

describe('Composer and the keyboard', () => {
  it("doesn't re-render when the keyboard opens: the screen's insets change, the composer's props don't", () => {
    const f = fakes();
    const screen = (bottom: number) => (
      <GlassContext.Provider value={{ mode: 'flat', View: null, reduceMotion: true }}>
        <ChromeContext.Provider value={{ top: 52, bottom }}>
          <LiveScreen model={f.model as unknown as LiveModel} voice={f.voice as unknown as VoiceModel} attach={f.attach as unknown as AttachmentsModel} />
        </ChromeContext.Provider>
      </GlassContext.Provider>
    );
    let r!: ReactTestRenderer;
    act(() => {
      r = create(screen(24));
    });
    const composer = () => r.root.findAll((n) => 'handle' in n.props && 'menu' in n.props, { deep: false })[0]!;
    const before = composer().props as Record<string, unknown>;
    act(() => r.update(screen(0))); // the keyboard is up: no gesture-area inset
    const after = composer().props as Record<string, unknown>;
    expect(Object.keys(after).every((k) => Object.is(after[k], before[k]))).toBe(true);
  });
});

describe('Composer menu', () => {
  it('opens above the button with labelled menu items, and says it is expanded', () => {
    const r = render(fakes());
    expect(menuOpen(r)).toBe(false);
    press(r, MENU_LABEL);
    expect(labels(r, 'menuitem')).toEqual(['Camera', 'Gallery', 'Audio file', 'Record', 'Commands']);
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'menu')).not.toHaveLength(0);
    const button = byLabel(r, CLOSE_LABEL).find((n) => n.props.accessibilityRole === 'button')!;
    expect(button.props.accessibilityState).toMatchObject({ expanded: true });
    // The panel is frosted glass with the rim.
    expect(glassIn(r).some((g) => g.props.level === 'panel' && g.props.rim)).toBe(true);
  });

  it('leaves out Record without voice input', () => {
    const r = render(fakes({ canTalk: false }));
    press(r, MENU_LABEL);
    expect(labels(r, 'menuitem')).toEqual(['Camera', 'Gallery', 'Audio file', 'Commands']);
  });

  it('runs the attachment flows and Record, closing as it goes', () => {
    const f = fakes();
    const r = render(f);
    for (const [label, source] of [
      ['Camera', 'camera'],
      ['Gallery', 'library'],
      ['Audio file', 'audio'],
    ] as const) {
      press(r, MENU_LABEL);
      press(r, label);
      expect(f.attach.add).toHaveBeenLastCalledWith(source);
      expect(menuOpen(r)).toBe(false);
    }
    press(r, MENU_LABEL);
    press(r, 'Record');
    expect(f.voice.start).toHaveBeenCalledTimes(1);
    expect(menuOpen(r)).toBe(false);
  });

  it('closes on a tap outside, on the button again and on back', () => {
    const r = render(fakes());
    press(r, MENU_LABEL);
    act(() => r.root.find((n) => n.props.testID === 'composer-menu-outside').props.onPress());
    expect(menuOpen(r)).toBe(false);

    press(r, MENU_LABEL);
    press(r, CLOSE_LABEL);
    expect(menuOpen(r)).toBe(false);

    press(r, MENU_LABEL);
    let handled = false;
    act(() => void (handled = backHandlers.at(-1)!()));
    expect(handled).toBe(true);
    expect(menuOpen(r)).toBe(false);
    expect(backHandlers).toHaveLength(0); // nothing left listening once closed
  });

  it('closes when the message box is focused', () => {
    const r = render(fakes());
    press(r, MENU_LABEL);
    act(() => input(r).props.onFocus());
    expect(menuOpen(r)).toBe(false);
  });

  it("lists the server's commands: one without arguments runs, one with arguments goes into the box", async () => {
    const f = fakes();
    const r = render(f);
    press(r, MENU_LABEL);
    await act(async () => press(r, 'Commands'));
    expect(f.model.commands).toHaveBeenCalled();
    expect(labels(r, 'menuitem')).toEqual(['/compact', '/remind']);
    expect(texts(r)).toContain('Compact the context');

    // Back goes to the first page, not out of the menu.
    act(() => void backHandlers.at(-1)!());
    expect(labels(r, 'menuitem')).toContain('Camera');

    await act(async () => press(r, 'Commands'));
    press(r, '/compact');
    expect(f.model.send).toHaveBeenCalledWith('/compact');
    expect(menuOpen(r)).toBe(false);

    press(r, MENU_LABEL);
    await act(async () => press(r, 'Commands'));
    act(() => input(r).props.onChangeText('tomorrow 9am call mom'));
    press(r, '/remind');
    expect(input(r).props.value).toBe('/remind tomorrow 9am call mom');
    expect(f.model.send).toHaveBeenCalledTimes(1);
  });

  it('says when the commands could not load, and tries again', async () => {
    const f = fakes();
    f.model.commands.mockRejectedValueOnce(new Error('offline'));
    const r = render(f);
    press(r, MENU_LABEL);
    await act(async () => press(r, 'Commands'));
    expect(texts(r)).toContain("Couldn't load the commands: offline");
    await act(async () => press(r, 'Try again'));
    expect(labels(r, 'menuitem')).toEqual(['/compact', '/remind']);
  });
});
