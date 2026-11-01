// The shared Settings pieces: compact rows, cards with inset hairlines, sentence-case sections with
// helper text under the card, switch rows (whole-row and open-the-page), segments, sliders with their
// value, the top summary card and the bottom pill.

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { StyleSheet, Text, View } from 'react-native';

import { ICON_INSET, PillButton, Row, ROW_HEIGHT, Section, SegmentRow, SettingsCard, SliderRow, SummaryCard, SwitchRow } from '../SettingsRows';

jest.setTimeout(30_000); // the first run transforms React Native

const mounted: ReactTestRenderer[] = [];
function render(node: React.ReactElement) {
  jest.spyOn(console, 'error').mockImplementation(() => {}); // react-test-renderer is deprecated in React 19
  let r!: ReactTestRenderer;
  act(() => {
    r = create(node);
  });
  mounted.push(r);
  return r;
}
const texts = (r: ReactTestRenderer) =>
  r.root
    .findAllByType(Text)
    .map((t) => [t.props.children].flat(3).join(''))
    .join(' | ');
const pressables = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.props.onPress === 'function' && n.props.accessibilityRole);
/** The glass cards (ui/Glass, memoised: found by its props). */
const glassOf = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.type !== 'string' && n.props.level === 'regular' && 'rim' in n.props);
const chevrons = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.name === 'chevron-right' && typeof n.type !== 'string').length;

describe('Settings rows', () => {
  afterEach(() => act(() => mounted.splice(0).forEach((r) => r.unmount())));

  it('Row: one line with its value on the right and a chevron, read as one button', () => {
    let pressed = 0;
    const r = render(<Row icon="bell-outline" label="Push" value="Every 15 min" onPress={() => pressed++} accessibilityHint="Opens Push" />);
    const [button] = pressables(r);
    expect(button!.props.accessibilityRole).toBe('button');
    expect(button!.props.accessibilityLabel).toBe('Push, Every 15 min');
    expect(button!.props.accessibilityHint).toBe('Opens Push');
    expect(StyleSheet.flatten(button!.props.style).minHeight).toBe(ROW_HEIGHT);
    expect(chevrons(r)).toBeGreaterThan(0);
    act(() => button!.props.onPress());
    expect(pressed).toBe(1);
  });

  it('Row: without onPress it is plain text with no chevron; busy disables it', () => {
    const plain = render(<Row label="Address" value="http://edith:8787" />);
    expect(pressables(plain)).toHaveLength(0);
    expect(chevrons(plain)).toBe(0);
    expect(texts(plain)).toContain('http://edith:8787');
    const busy = render(<Row label="Refresh" onPress={() => {}} busy chevron={false} />);
    expect(pressables(busy)[0]!.props.accessibilityState).toEqual({ disabled: true, busy: true });
    expect(chevrons(busy)).toBe(0);
  });

  it('Row with buttons of its own: TalkBack reaches each button; the text keeps the tap and long press as actions', () => {
    const calls: string[] = [];
    const r = render(
      <Row label="Work" onPress={() => calls.push('tap')} onLongPress={() => calls.push('long')} longPressLabel="Rename" trailing={<PillButton label="Switch" onPress={() => calls.push('switch')} />} />,
    );
    const outer = r.root.find((n) => n.props.accessible === false && typeof n.props.onLongPress === 'function');
    expect(outer.props.accessibilityLabel).toBeUndefined();
    const text = r.root.find((n) => n.props.accessibilityLabel === 'Work' && typeof n.props.onAccessibilityAction === 'function');
    expect(text.props.accessibilityActions).toEqual([{ name: 'activate' }, { name: 'longpress', label: 'Rename' }]);
    act(() => text.props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } }));
    act(() => text.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
    act(() => r.root.find((n) => n.props.accessibilityLabel === 'Switch' && typeof n.props.onPress === 'function').props.onPress());
    expect(calls).toEqual(['long', 'tap', 'switch']);
  });

  it('SettingsCard: one glass card with a rim, a hairline between rows inset past the icon', () => {
    const r = render(
      <SettingsCard>
        <Row icon="bell-outline" label="A" />
        <Row label="B" />
        {null}
        <Row icon="cog-outline" label="C" />
      </SettingsCard>,
    );
    const glass = glassOf(r);
    expect(glass).toHaveLength(1);
    expect(glass[0]!.props.rim).toBe(true);
    const dividers = r.root.findAll((n) => n.type === View && StyleSheet.flatten(n.props.style)?.height === StyleSheet.hairlineWidth);
    expect(dividers).toHaveLength(2); // between three rows (the null is skipped)
    expect(dividers.map((d) => StyleSheet.flatten(d.props.style).marginLeft)).toEqual([16, ICON_INSET]); // B has no icon, C has one
  });

  it('Section: a sentence-case header, then the card, then helper text under it', () => {
    const r = render(
      <Section title="Delivery" footer="Checks every 15 minutes.">
        <Row label="Mode" />
      </Section>,
    );
    const header = r.root.find((n) => n.type === Text && n.props.accessibilityRole === 'header');
    expect(header.props.children).toBe('Delivery');
    expect(StyleSheet.flatten(header.props.style).textTransform).toBeUndefined();
    const shown = texts(r);
    expect(shown.indexOf('Delivery')).toBeLessThan(shown.indexOf('Mode'));
    expect(shown.indexOf('Mode')).toBeLessThan(shown.indexOf('Checks every 15 minutes.'));
    const [glass] = glassOf(r);
    expect(glass!.findAll((n) => n.type === Text && n.props.children === 'Checks every 15 minutes.')).toHaveLength(0); // not inside the card
  });

  it('SwitchRow alone: the whole row is the switch', () => {
    const changes: boolean[] = [];
    const r = render(<SwitchRow label="Send right after speaking" value={false} onChange={(v) => changes.push(v)} />);
    const switches = r.root.findAll((n) => n.props.accessibilityRole === 'switch' && typeof n.props.onPress === 'function');
    expect(switches).toHaveLength(1);
    expect(switches[0]!.props.accessibilityState).toEqual({ checked: false, disabled: false });
    act(() => switches[0]!.props.onPress());
    expect(changes).toEqual([true]);
  });

  it('SwitchRow with a page: the row opens it, the switch is its own stop, and a chevron shows', () => {
    const changes: boolean[] = [];
    let opened = 0;
    const r = render(<SwitchRow icon="bell-outline" label="Push" value detail="Instant" onChange={(v) => changes.push(v)} onOpen={() => opened++} />);
    const sw = r.root.find((n) => n.props.accessibilityRole === 'switch' && typeof n.props.onPress === 'function');
    expect(sw.props.accessibilityLabel).toBe('Push');
    expect(sw.props.accessibilityState).toMatchObject({ checked: true });
    act(() => sw.props.onPress());
    expect(changes).toEqual([false]);
    expect(opened).toBe(0);
    const open = r.root.find((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function');
    expect(open.props.accessibilityLabel).toBe('Push, Instant');
    expect(open.props.accessibilityHint).toBe('Opens Push');
    act(() => open.props.onPress());
    expect(opened).toBe(1);
    expect(chevrons(r)).toBeGreaterThan(0);
  });

  it('SegmentRow: radios with the chosen one checked; choosing it again does nothing', () => {
    const picked: string[] = [];
    const r = render(
      <SegmentRow
        label="Work details"
        options={[
          { id: 'a', label: 'Summary' },
          { id: 'b', label: 'Steps' },
        ]}
        value="b"
        onChange={(id) => picked.push(id)}
      />,
    );
    expect(r.root.find((n) => n.props.accessibilityRole === 'radiogroup').props.accessibilityLabel).toBe('Work details');
    const radios = r.root.findAll((n) => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function');
    expect(radios.map((n) => n.props.accessibilityState)).toEqual([
      { checked: false, disabled: false },
      { checked: true, disabled: false },
    ]); // checked only: "selected" too would be read twice
    const label = r.root.findAll((n) => n.type === Text && n.props.children === 'Summary')[0]!;
    expect(label.props).toMatchObject({ numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.8 });
    act(() => radios[1]!.props.onPress());
    act(() => radios[0]!.props.onPress());
    expect(picked).toEqual(['a']);
  });

  it('SliderRow: the value beside the label, and words at each end', () => {
    const r = render(<SliderRow label="Sensitivity" value={0.35} onChange={() => {}} ends={['Fewer', 'More']} />);
    expect(texts(r)).toContain('Sensitivity | 35%');
    expect(texts(r)).toContain('Fewer | More');
    expect(r.root.find((n) => n.props.accessibilityRole === 'adjustable').props.accessibilityLabel).toBe('Sensitivity');
    const custom = render(<SliderRow label="Glass" value={0.5} onChange={() => {}} valueText={(v) => `${Math.round(v * 10)} of 10`} />);
    expect(texts(custom)).toContain('5 of 10');
  });

  it('SummaryCard: title and state, a big switch when it has one, a button when it opens something', () => {
    const changes: boolean[] = [];
    const r = render(<SummaryCard icon="bell-outline" title="Push" subtitle="Off" toggle={{ value: false, onChange: (v) => changes.push(v), label: 'Push' }} />);
    expect(texts(r)).toContain('Push | Off');
    const sw = r.root.find((n) => n.props.accessibilityRole === 'switch' && typeof n.props.onPress === 'function');
    act(() => sw.props.onPress());
    expect(changes).toEqual([true]);
    expect(r.root.findAll((n) => n.props.accessibilityRole === 'button')).toHaveLength(0);
    let opened = 0;
    const card = render(<SummaryCard title="E.D.I.T.H" subtitle="Connected · Interseqt active" onPress={() => opened++} accessibilityHint="Opens Server connection" />);
    const button = card.root.find((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function');
    expect(button.props.accessibilityLabel).toBe('E.D.I.T.H, Connected · Interseqt active');
    act(() => button.props.onPress());
    expect(opened).toBe(1);
  });

  it('PillButton: full width, at least 48 dp, busy and disabled said to TalkBack', () => {
    let pressed = 0;
    const r = render(<PillButton label="Check for updates" icon="refresh" onPress={() => pressed++} />);
    const [button] = pressables(r);
    expect(button!.props.accessibilityLabel).toBe('Check for updates');
    act(() => button!.props.onPress());
    expect(pressed).toBe(1);
    const pill = r.root.findAll((n) => n.type === View && StyleSheet.flatten(n.props.style)?.borderRadius === 999);
    expect(pill.length).toBeGreaterThan(0);
    expect(StyleSheet.flatten(pill[0]!.props.style).minHeight).toBeGreaterThanOrEqual(48);
    const busy = render(<PillButton label="Turn on" onPress={() => {}} busy />);
    expect(pressables(busy)[0]!.props.accessibilityState).toEqual({ disabled: true, busy: true });
  });
});
