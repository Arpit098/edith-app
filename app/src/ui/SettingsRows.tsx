// The pieces every Settings page is built from, so the list and each page look the same (Arpit, 1 Nov:
// "it should have the structure of the other image", and "inside the setting options we need better
// UI"): a summary card at the top, sections with a sentence-case title, glass cards of compact rows
// (one line, a neutral outline icon, dim trailing text, a chevron) split by hairlines inset from the
// icon, inline switches, segmented choices, sliders with their value, helper text under a card (not in
// it), and one full-width pill for a page's main action.

import { Children, Fragment, isValidElement, memo, type ReactElement, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type, useTheme } from '../core/theme';
import { Glass } from './Glass';
import { Icon } from './Icon';
import { Squish } from './motion';
import { Slider } from './Slider';
import { Toggle, TOUCH } from './Toggle';

const ICON = 20;
export const ROW_HEIGHT = 52;
/** Where a row's divider starts: under its label, past the icon. */
export const ICON_INSET = space.l + ICON + space.m;

// ---- cards and sections ----

/** A glass card (thin rim) holding rows, with a hairline between them inset from the icons. */
export function SettingsCard({ children }: { children?: ReactNode }) {
  const rows = Children.toArray(children).filter(isValidElement) as ReactElement<{ icon?: string }>[];
  return (
    <Glass level="regular" rim style={styles.card}>
      {rows.map((row, i) => (
        <Fragment key={row.key ?? i}>
          {i > 0 ? <View style={[styles.divider, { marginLeft: row.props.icon ? ICON_INSET : space.l }]} /> : null}
          {row}
        </Fragment>
      ))}
    </Glass>
  );
}

/** A titled group: "Delivery", then its card, then helper text in dim small type under it. */
export function Section({ title, footer, children }: { title?: string; footer?: ReactNode; children?: ReactNode }) {
  return (
    <View style={styles.section}>
      {title ? (
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      <SettingsCard>{children}</SettingsCard>
      {footer ? typeof footer === 'string' ? <Helper>{footer}</Helper> : footer : null}
    </View>
  );
}

/** Helper text under a card. */
export function Helper({ children, tone, live }: { children?: ReactNode; tone?: 'error' | 'ok'; live?: boolean }) {
  return (
    <Text style={[styles.helper, tone === 'error' && styles.error, tone === 'ok' && styles.ok]} accessibilityLiveRegion={live ? 'polite' : undefined}>
      {children}
    </Text>
  );
}

/** A page's body: its cards with even spacing. */
export function SettingsPageBody({ children }: { children?: ReactNode }) {
  return <View style={styles.page}>{children}</View>;
}

// ---- rows ----

export interface RowProps {
  label: string;
  icon?: string;
  iconColor?: string;
  /** Dim text on the right, before the chevron (a short state: "Every 15 min"). */
  value?: string | null;
  /** The value in dim monospace (a /command, a path). */
  mono?: boolean;
  /** A second line under the label, for rows that need one (an account's email). */
  sub?: string | null;
  onPress?: () => void;
  onLongPress?: () => void;
  /** Shown when the row opens something (default: whenever it has onPress). */
  chevron?: boolean;
  /** Controls on the right instead of (or after) the value: small buttons, a switch. */
  trailing?: ReactNode;
  tone?: 'danger' | 'accent';
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** What TalkBack calls the long press when the row has controls of its own (e.g. "Rename"). */
  longPressLabel?: string;
  /** For a row that shows or hides more below it. */
  expanded?: boolean;
  selectable?: boolean;
}

/** One line: icon, label, dim value, chevron. Pressable when it has onPress. */
export const Row = memo(function Row({ label, icon, iconColor, value, mono, sub, onPress, onLongPress, chevron, trailing, tone, disabled, busy, accessibilityLabel, accessibilityHint, longPressLabel, expanded, selectable }: RowProps) {
  const { accent } = useTheme();
  const toneColor = tone === 'danger' ? colors.danger : tone === 'accent' ? accent : undefined;
  const a11y = accessibilityLabel ?? [label, value, sub].filter(Boolean).join(', ');
  const off = !!(disabled || busy);
  const state = { disabled: off, busy: !!busy, ...(expanded === undefined ? null : { expanded }) };
  const text = (
    <>
      {icon ? <Icon name={icon} size={ICON} color={iconColor ?? toneColor ?? colors.textSecondary} /> : null}
      <View style={styles.flex}>
        <Text style={[styles.label, toneColor ? { color: toneColor } : null]} numberOfLines={1} selectable={selectable}>
          {label}
        </Text>
        {sub ? (
          <Text style={styles.sub} numberOfLines={2}>
            {sub}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text style={[styles.value, mono && styles.mono]} numberOfLines={1} selectable={selectable}>
          {value}
        </Text>
      ) : null}
    </>
  );
  const controls = (
    <>
      {busy ? <ActivityIndicator size="small" color={colors.textDim} /> : null}
      {trailing}
      {(chevron ?? !!onPress) ? <Icon name="chevron-right" size={20} color={colors.textFaint} /> : null}
    </>
  );
  if (!onPress && !onLongPress) {
    return (
      <View style={[styles.row, sub ? styles.tall : null]}>
        <View style={styles.textArea} accessible accessibilityLabel={a11y}>
          {text}
        </View>
        {controls}
      </View>
    );
  }
  if (trailing) {
    // The row has buttons of its own: the row isn't one TalkBack stop (it would swallow them). Its
    // text is, with the tap and the long press as actions; each button is its own stop.
    const actions = [...(onPress ? [{ name: 'activate' }] : []), ...(onLongPress ? [{ name: 'longpress', label: longPressLabel }] : [])];
    return (
      <Pressable onPress={onPress} onLongPress={onLongPress} disabled={off} android_ripple={{ color: colors.ripple }} accessible={false} style={[styles.row, sub ? styles.tall : null, off && styles.dimmed]}>
        <View
          style={styles.textArea}
          accessible
          accessibilityRole={onPress ? 'button' : undefined}
          accessibilityLabel={a11y}
          accessibilityHint={accessibilityHint}
          accessibilityState={state}
          accessibilityActions={actions}
          onAccessibilityAction={(e) => (e.nativeEvent.actionName === 'longpress' ? onLongPress?.() : onPress?.())}
        >
          {text}
        </View>
        {controls}
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={off}
      android_ripple={{ color: colors.ripple }}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityHint={accessibilityHint}
      accessibilityState={state}
      style={[styles.row, sub ? styles.tall : null, off && styles.dimmed]}
    >
      {text}
      {controls}
    </Pressable>
  );
});

export interface SwitchRowProps {
  label: string;
  value: boolean;
  onChange: (on: boolean) => void;
  icon?: string;
  sub?: string | null;
  disabled?: boolean;
  /** Dim text before the switch (e.g. "Every 15 min" on Push). */
  detail?: string | null;
  /**
   * The row opens a page with more options: a tap on the row opens it, the switch is its own
   * TalkBack stop and touch target, and a chevron shows. Without it, the whole row is the switch.
   */
  onOpen?: () => void;
  openHint?: string;
}

/** A setting that is just on or off, with the switch inline. */
export const SwitchRow = memo(function SwitchRow({ label, value, onChange, icon, sub, disabled, detail, onOpen, openHint }: SwitchRowProps) {
  const text = (
    <>
      {icon ? <Icon name={icon} size={ICON} color={colors.textSecondary} /> : null}
      <View style={styles.flex}>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </View>
      {detail ? (
        <Text style={styles.value} numberOfLines={1}>
          {detail}
        </Text>
      ) : null}
    </>
  );
  if (onOpen) {
    return (
      <View style={[styles.row, styles.switchRow, sub ? styles.tall : null]}>
        <Pressable
          onPress={onOpen}
          android_ripple={{ color: colors.ripple }}
          style={styles.openArea}
          accessibilityRole="button"
          accessibilityLabel={[label, detail].filter(Boolean).join(', ')}
          accessibilityHint={openHint ?? `Opens ${label}`}
        >
          {text}
        </Pressable>
        <Toggle value={value} onChange={onChange} label={label} disabled={disabled} />
        <Pressable onPress={onOpen} hitSlop={8} importantForAccessibility="no" accessibilityElementsHidden style={styles.chevron}>
          <Icon name="chevron-right" size={20} color={colors.textFaint} />
        </Pressable>
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      android_ripple={{ color: colors.ripple }}
      style={[styles.row, styles.switchRow, sub ? styles.tall : null]}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={sub ?? undefined}
      accessibilityState={{ checked: value, disabled: !!disabled }}
    >
      {text}
      <Toggle value={value} onChange={onChange} label={label} disabled={disabled} decorative />
    </Pressable>
  );
});

export interface SegmentOption<T extends string> {
  id: T;
  label: string;
}

/** A choice among a few: a segmented control under an optional label, instead of a list of radios. */
export function SegmentRow<T extends string>({ label, icon, options, value, onChange, disabled }: { label?: string; icon?: string; options: readonly SegmentOption<T>[]; value: T; onChange: (id: T) => void; disabled?: boolean }) {
  const { accentSoft } = useTheme();
  return (
    <View style={styles.block}>
      {label ? (
        <View style={styles.blockHead}>
          {icon ? <Icon name={icon} size={ICON} color={colors.textSecondary} /> : null}
          <Text style={[styles.label, styles.flex]}>{label}</Text>
        </View>
      ) : null}
      <View style={styles.segments} accessibilityRole="radiogroup" accessibilityLabel={label}>
        {options.map((o) => {
          const on = o.id === value;
          return (
            <Pressable
              key={o.id}
              onPress={() => !on && onChange(o.id)}
              disabled={disabled}
              style={[styles.segment, on && { backgroundColor: accentSoft, borderColor: colors.hairline }]}
              accessibilityRole="radio"
              accessibilityLabel={o.label}
              accessibilityState={{ checked: on, disabled: !!disabled }}
            >
              <Text style={[styles.segmentText, on && styles.segmentOn]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** A 0..1 setting with its value shown beside the label, and optional words at each end. */
export function SliderRow({ label, icon, value, onChange, valueText, ends }: { label: string; icon?: string; value: number; onChange: (v: number) => void; valueText?: (v: number) => string; ends?: [string, string] }) {
  const shown = (valueText ?? percent)(value);
  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        {icon ? <Icon name={icon} size={ICON} color={colors.textSecondary} /> : null}
        <Text style={[styles.label, styles.flex]}>{label}</Text>
        <Text style={styles.value}>{shown}</Text>
      </View>
      <Slider value={value} onChange={onChange} label={label} valueText={valueText} />
      {ends ? (
        <View style={styles.ends}>
          <Text style={styles.helperInline}>{ends[0]}</Text>
          <Text style={styles.helperInline}>{ends[1]}</Text>
        </View>
      ) : null}
    </View>
  );
}

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** Free content inside a card (a form, a status block), with the rows' padding. */
export function CardBlock({ children }: { children?: ReactNode }) {
  return <View style={styles.block}>{children}</View>;
}

// ---- the top card and the bottom pill ----

export interface SummaryCardProps {
  title: string;
  subtitle?: string | null;
  icon?: string;
  /** Drawn instead of the icon (the main list's orb). */
  leading?: ReactNode;
  tone?: 'ok' | 'warn' | 'danger';
  /** A big switch on the right (Push: on or off). */
  toggle?: { value: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean };
  onPress?: () => void;
  accessibilityHint?: string;
}

/** The card at the top of a page: what it is and its state in a line, with a big switch if it has one. */
export function SummaryCard({ title, subtitle, icon, leading, tone, toggle, onPress, accessibilityHint }: SummaryCardProps) {
  const { accent, accentSoft } = useTheme();
  const toneColor = tone === 'ok' ? colors.ok : tone === 'warn' ? colors.warn : tone === 'danger' ? colors.danger : colors.textDim;
  const content = (
    <>
      {leading ?? (icon ? (
        <View style={[styles.badge, { backgroundColor: accentSoft }]}>
          <Icon name={icon} size={24} color={accent} />
        </View>
      ) : null)}
      <View style={styles.flex}>
        <Text style={styles.summaryTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[styles.summarySub, { color: toneColor }]} numberOfLines={2} accessibilityLiveRegion="polite">
            {subtitle}
          </Text>
        ) : null}
      </View>
      {toggle ? <Toggle size="large" value={toggle.value} onChange={toggle.onChange} label={toggle.label} disabled={toggle.disabled} /> : null}
      {onPress ? <Icon name="chevron-right" size={22} color={colors.textFaint} /> : null}
    </>
  );
  return (
    <Glass level="regular" rim style={styles.card}>
      {onPress ? (
        <Pressable onPress={onPress} android_ripple={{ color: colors.ripple }} style={styles.summary} accessibilityRole="button" accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')} accessibilityHint={accessibilityHint}>
          {content}
        </Pressable>
      ) : (
        <View style={styles.summary}>{content}</View>
      )}
    </Glass>
  );
}

export interface PillButtonProps {
  label: string;
  onPress: () => void;
  icon?: string;
  variant?: 'primary' | 'plain' | 'danger';
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
}

/** A page's one main action: a full-width pill at the bottom ("Check for updates", "Change server"). */
export const PillButton = memo(function PillButton({ label, onPress, icon, variant = 'plain', disabled, busy, accessibilityHint }: PillButtonProps) {
  const theme = useTheme();
  const bg = variant === 'primary' ? theme.accent : variant === 'danger' ? colors.dangerSoft : colors.text;
  const fg = variant === 'primary' ? theme.accentText : variant === 'danger' ? colors.danger : colors.bg;
  const off = disabled || busy;
  return (
    <Squish
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={[styles.pill, { backgroundColor: bg, opacity: off ? 0.5 : 1 }]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Icon name={icon} size={20} color={fg} /> : null}
      <Text style={[styles.pillText, { color: fg }]}>{label}</Text>
    </Squish>
  );
});

/** A warning in its own card, with an optional action under the text. */
export function Notice({ text, action, tone = 'warn' }: { text: string; action?: ReactNode; tone?: 'warn' | 'danger' }) {
  const color = tone === 'danger' ? colors.danger : colors.warn;
  return (
    <View style={[styles.notice, { borderColor: color }]} accessibilityRole="alert">
      <View style={styles.blockHead}>
        <Icon name="alert-circle-outline" size={ICON} color={color} />
        <Text style={[styles.noticeText, styles.flex]}>{text}</Text>
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  page: { gap: space.l },
  section: { gap: space.s },
  sectionTitle: { color: colors.text, fontSize: type.size.body, fontWeight: '600', paddingHorizontal: space.xs },
  card: { overflow: 'hidden' },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginRight: space.l },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, minHeight: ROW_HEIGHT, paddingVertical: space.xs },
  tall: { paddingVertical: space.s },
  switchRow: { paddingRight: space.s },
  textArea: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.m, minWidth: 0 },
  openArea: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.m, alignSelf: 'stretch', minHeight: TOUCH },
  chevron: { justifyContent: 'center' },
  dimmed: { opacity: 0.5 },
  label: { color: colors.text, fontSize: type.size.body, fontWeight: '500' },
  sub: { color: colors.textDim, fontSize: type.size.small, marginTop: 1 },
  value: { color: colors.textDim, fontSize: type.size.small, flexShrink: 1, maxWidth: '55%', textAlign: 'right' },
  mono: { fontFamily: type.mono, fontSize: 12 },
  helper: { color: colors.textDim, fontSize: type.size.small, paddingHorizontal: space.xs, lineHeight: 18 },
  helperInline: { color: colors.textDim, fontSize: type.size.small },
  error: { color: colors.danger },
  ok: { color: colors.ok },
  block: { paddingHorizontal: space.l, paddingVertical: space.m, gap: space.s },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  ends: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -space.xs },
  segments: { flexDirection: 'row', padding: 3, gap: 3, borderRadius: radius.m, backgroundColor: colors.input },
  segment: { flex: 1, minHeight: 40, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.s, borderRadius: radius.m - 3, borderWidth: StyleSheet.hairlineWidth, borderColor: 'transparent' },
  segmentText: { color: colors.textDim, fontSize: type.size.small, fontWeight: '500' },
  segmentOn: { color: colors.text, fontWeight: '700' },
  summary: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingHorizontal: space.l, paddingVertical: space.m, minHeight: 72 },
  badge: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  summaryTitle: { color: colors.text, fontSize: type.size.title, fontWeight: '700' },
  summarySub: { fontSize: type.size.small, marginTop: 2 },
  pill: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s, minHeight: TOUCH, borderRadius: radius.pill, paddingHorizontal: space.xl },
  pillText: { fontSize: type.size.body, fontWeight: '600' },
  notice: { gap: space.s, padding: space.m, borderRadius: radius.l, borderWidth: StyleSheet.hairlineWidth, backgroundColor: colors.cardRaised },
  noticeText: { color: colors.text, fontSize: type.size.small },
});
