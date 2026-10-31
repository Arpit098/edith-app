// Appearance's sections: Theme, Background, Bubbles, Accent and Glass. Each applies a tap at once.
// The builders ("Custom…") hand their draft to the page (`onDraft`) so the preview shows it live;
// it's stored only on Save.

import { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  ACCENTS,
  BACKGROUNDS,
  backgroundLook,
  BUBBLE_GRADIENTS,
  CUSTOM_BUBBLE,
  DEFAULT_APPEARANCE,
  DEFAULT_GLASS,
  DEFAULT_INTENSITY,
  GRADIENT_BACKGROUNDS,
  INK_LIGHT,
  MAX_CUSTOM,
  NEW_BACKGROUND_GRADIENT,
  NEW_BUBBLE_GRADIENT,
  nextCustomId,
  PRESETS,
  space,
  SWATCHES,
  type as typography,
  useTheme,
  withAlpha,
  colors,
  type Appearance,
  type BubbleGradient,
  type GradientSpec,
} from '../../core/theme';
import { Ambient } from '../../ui/Ambient';
import { Icon } from '../../ui/Icon';
import { Slider } from '../../ui/Slider';
import { GradientBuilder } from './GradientBuilder';
import { Heading, Hint, LinkButton, shared, Swatch, Tile } from './parts';

export interface SectionProps {
  appearance: Appearance;
  set: (change: Partial<Appearance>) => void;
}

// ---- Theme ----

const TILE_LOOKS = new Map(PRESETS.map((p) => [p.id, backgroundLook(p, DEFAULT_APPEARANCE.background)]));

export function ThemeSection({ appearance, set }: SectionProps) {
  return (
    <View style={shared.tiles} accessibilityRole="radiogroup">
      {PRESETS.map((p) => (
        <Tile
          key={p.id}
          name={p.name}
          label={`${p.name} theme`}
          on={appearance.theme === p.id}
          ring={p.accent}
          onPress={() => set({ theme: p.id })}
          art={<ThemeArt id={p.id} accent={p.accent} on={appearance.theme === p.id} />}
        />
      ))}
    </View>
  );
}

const ThemeArt = memo(function ThemeArt({ id, accent, on }: { id: string; accent: string; on: boolean }) {
  return (
    <>
      <Ambient look={TILE_LOOKS.get(id)} />
      <View style={[styles.dot, { backgroundColor: accent }]} />
      {on ? <Icon name="check" size={14} color={colors.text} /> : null}
    </>
  );
});

// ---- Background ----

/** The builder's state: a new gradient (id null) or an existing one being changed. */
type Editing = { id: string | null; spec: GradientSpec } | null;

export function BackgroundSection({ appearance, set, onDraft }: SectionProps & { onDraft: (d: Partial<Appearance> | null) => void }) {
  const { preset } = useTheme();
  const [editing, setEditing] = useState<Editing>(null);
  const customs = appearance.customGradients;
  // Every choice drawn as it would be (the same Ambient the app draws), still.
  const themed = useMemo(() => BACKGROUNDS.map((b) => ({ ...b, look: backgroundLook(preset, b.id) })), [preset]);
  const gradients = useMemo(() => GRADIENT_BACKGROUNDS.map((b) => ({ ...b, look: backgroundLook(preset, b.id) })), [preset]);
  const own = useMemo(() => customs.map((c, i) => ({ id: c.id, name: `Custom ${i + 1}`, look: backgroundLook(preset, c.id, customs) })), [preset, customs]);

  const edit = (next: Editing) => {
    setEditing(next);
    // The draft as a background of its own, shown by the preview only.
    onDraft(next ? { customGradients: [...customs, { id: 'custom-draft', ...next.spec }], background: 'custom-draft' } : null);
  };
  const save = () => {
    if (!editing) return;
    const id = editing.id ?? nextCustomId(customs);
    const list = editing.id ? customs.map((c) => (c.id === id ? { id, ...editing.spec } : c)) : [...customs, { id, ...editing.spec }];
    set({ customGradients: list, background: id });
    edit(null);
  };
  const remove = () => {
    if (!editing?.id) return;
    const list = customs.filter((c) => c.id !== editing.id);
    set({ customGradients: list, ...(appearance.background === editing.id ? { background: DEFAULT_APPEARANCE.background } : {}) });
    edit(null);
  };

  if (editing) {
    return (
      <GradientBuilder
        mode="background"
        title={editing.id ? 'Edit gradient' : 'New gradient'}
        value={editing.spec}
        onChange={(spec) => edit({ ...editing, spec })}
        onSave={save}
        onCancel={() => edit(null)}
        onDelete={editing.id ? remove : undefined}
      />
    );
  }
  const chosen = customs.find((c) => c.id === appearance.background);
  const tile = (b: { id: string; name: string; look: ReturnType<typeof backgroundLook>; drift?: boolean }) => (
    <Tile
      key={b.id}
      name={b.name}
      label={`${b.name} background`}
      on={appearance.background === b.id}
      onPress={() => set({ background: b.id })}
      art={
        <>
          <Ambient look={b.look} />
          {b.drift ? <Icon name="waves" size={16} color={colors.textDim} /> : null}
        </>
      }
    />
  );
  return (
    <>
      <Heading>In the theme’s colours</Heading>
      <View style={shared.tiles} accessibilityRole="radiogroup">
        {themed.map(tile)}
      </View>
      <Heading>Gradients</Heading>
      <View style={shared.tiles} accessibilityRole="radiogroup">
        {gradients.map(tile)}
      </View>
      <Heading>{`Your gradients (${customs.length} of ${MAX_CUSTOM})`}</Heading>
      {own.length ? (
        <View style={shared.tiles} accessibilityRole="radiogroup">
          {own.map(tile)}
        </View>
      ) : (
        <Hint>None yet: make one with Custom…</Hint>
      )}
      <View style={shared.links}>
        <LinkButton label="Custom…" a11y="New custom gradient" disabled={customs.length >= MAX_CUSTOM} onPress={() => edit({ id: null, spec: NEW_BACKGROUND_GRADIENT })} />
        {chosen ? <LinkButton label={`Edit ${own.find((o) => o.id === chosen.id)?.name ?? ''}`} onPress={() => edit({ id: chosen.id, spec: chosen })} /> : null}
      </View>
      {customs.length >= MAX_CUSTOM ? <Hint>{`You have ${MAX_CUSTOM}, the most kept: edit or delete one to make another.`}</Hint> : null}
      <Hint>The drifting ones move slowly; with “Remove animations” on they stay still.</Hint>
    </>
  );
}

// ---- Bubbles ----

export function BubblesSection({ appearance, set, onDraft }: SectionProps & { onDraft: (d: Partial<Appearance> | null) => void }) {
  const live = useTheme();
  const [editing, setEditing] = useState<{ side: 'my' | 'edith'; gradient: BubbleGradient } | null>(null);
  const edit = (next: typeof editing) => {
    setEditing(next);
    onDraft(next ? (next.side === 'my' ? { myBubble: CUSTOM_BUBBLE, myGradient: next.gradient } : { edithBubble: CUSTOM_BUBBLE, edithGradient: next.gradient }) : null);
  };
  if (editing) {
    const who = editing.side === 'my' ? 'my messages' : 'EDITH’s messages';
    return (
      <GradientBuilder
        mode="bubble"
        title={`Gradient for ${who}`}
        value={{ stops: editing.gradient.stops, angle: editing.gradient.angle, kind: 'linear', intensity: DEFAULT_INTENSITY }}
        onChange={(spec) => edit({ ...editing, gradient: { stops: [spec.stops[0]!, spec.stops[1] ?? spec.stops[0]!], angle: spec.angle } })}
        onSave={() => {
          set(editing.side === 'my' ? { myBubble: CUSTOM_BUBBLE, myGradient: editing.gradient } : { edithBubble: CUSTOM_BUBBLE, edithGradient: editing.gradient });
          edit(null);
        }}
        onCancel={() => edit(null)}
      />
    );
  }
  return (
    <>
      <Side
        title="My messages"
        who="my messages"
        value={appearance.myBubble}
        own={appearance.myGradient}
        themeDefault={live.accent}
        onPick={(id) => set({ myBubble: id })}
        onCustom={() => edit({ side: 'my', gradient: appearance.myGradient ?? NEW_BUBBLE_GRADIENT })}
      />
      <Side
        title="EDITH’s messages"
        who="EDITH’s messages"
        value={appearance.edithBubble}
        own={appearance.edithGradient}
        themeDefault={INK_LIGHT}
        onPick={(id) => set({ edithBubble: id })}
        onCustom={() => edit({ side: 'edith', gradient: appearance.edithGradient ?? NEW_BUBBLE_GRADIENT })}
      />
      <Hint>Text on every colour and gradient stays easy to read: they’re toned down where needed.</Hint>
    </>
  );
}

function Side({ title, who, value, own, themeDefault, onPick, onCustom }: { title: string; who: string; value: string | null; own: BubbleGradient | null; themeDefault: string; onPick: (id: string | null) => void; onCustom: () => void }) {
  return (
    <>
      <Heading>{title}</Heading>
      <View style={shared.row} accessibilityRole="radiogroup">
        <Swatch colors={[withAlpha(themeDefault, 0.35)]} on={value === null} onPress={() => onPick(null)} label={`Theme default for ${who}`} icon="auto-fix" />
        {SWATCHES.map((s) => (
          <Swatch key={s.id} colors={[s.color]} on={value === s.id} onPress={() => onPick(s.id)} label={`${s.name} for ${who}`} />
        ))}
      </View>
      <View style={shared.row} accessibilityRole="radiogroup">
        {BUBBLE_GRADIENTS.map((b) => (
          <Swatch key={b.id} colors={b.gradient.stops} angle={b.gradient.angle} on={value === b.id} onPress={() => onPick(b.id)} label={`${b.name} gradient for ${who}`} />
        ))}
        {own ? <Swatch colors={own.stops} angle={own.angle} on={value === CUSTOM_BUBBLE} onPress={() => onPick(CUSTOM_BUBBLE)} label={`Your gradient for ${who}`} /> : null}
      </View>
      <LinkButton label={own ? 'Edit your gradient…' : 'Custom…'} a11y={`Custom gradient for ${who}`} onPress={onCustom} />
    </>
  );
}

// ---- Accent ----

export function AccentSection({ appearance, set }: SectionProps) {
  const { preset } = useTheme();
  return (
    <>
      <View style={shared.row} accessibilityRole="radiogroup">
        <Swatch colors={[preset.accent]} on={appearance.accent === null} onPress={() => set({ accent: null })} label="Theme’s accent" icon="auto-fix" />
        {ACCENTS.map((a) => (
          <Swatch key={a.id} colors={[a.color]} on={appearance.accent === a.id} onPress={() => set({ accent: a.id })} label={`${a.name} accent`} />
        ))}
      </View>
      <Hint>Buttons, chips, links and the send button. Every accent reads clearly on every background.</Hint>
    </>
  );
}

// ---- Glass ----

export function GlassSection({ appearance, set, shown, onDrag }: SectionProps & { shown: number; onDrag: (v: number | null) => void }) {
  const live = useTheme(); // the app's theme (it knows "reduce transparency")
  return (
    <>
      <View style={styles.glassRow}>
        <Icon name="square-rounded-outline" size={18} color={colors.textDim} />
        <View style={shared.flex}>
          <Slider
            value={shown / 100}
            step={0.05}
            label="Glass"
            valueText={(v) => `${Math.round(v * 100)} percent`}
            onMove={(v) => onDrag(Math.round(v * 100))}
            onChange={(v) => {
              set({ glass: Math.round(v * 100) });
              onDrag(null);
            }}
          />
        </View>
        <Text style={styles.value} accessibilityElementsHidden importantForAccessibility="no">
          {shown}%
        </Text>
      </View>
      <Hint>
        0% is flat and solid: fastest, easiest to read. 100% is the most blur and bend. {DEFAULT_GLASS}% is the original look.
        {live.glass === 0 && appearance.glass > 0 ? ' Your phone asks for less transparency, so glass is off.' : ''}
      </Hint>
      {appearance.glass !== DEFAULT_GLASS ? <LinkButton label={`Back to ${DEFAULT_GLASS}%`} a11y={`Glass back to ${DEFAULT_GLASS}%`} onPress={() => set({ glass: DEFAULT_GLASS })} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  dot: { position: 'absolute', right: 8, bottom: 8, width: 12, height: 12, borderRadius: 6 },
  glassRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  value: { color: colors.text, fontSize: typography.size.body, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'right' },
});
