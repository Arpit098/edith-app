// Settings → Appearance: a live preview on top, then the theme, each side's bubble colour, the
// background and the glass slider. Every tap applies at once (the app re-renders in the new theme);
// the slider previews live while dragged and applies on release, so a drag repaints only the
// preview, not the whole app, on every move.

import { memo, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import {
  BACKGROUNDS,
  backgroundLook,
  colors,
  DEFAULT_APPEARANCE,
  DEFAULT_GLASS,
  INK_LIGHT,
  inkOn,
  PRESETS,
  radius,
  resolveTheme,
  space,
  SWATCHES,
  type,
  useAppearance,
  useTheme,
  withAlpha,
  type Appearance,
  type BackgroundId,
  type ThemePreset,
} from '../../core/theme';
import { Ambient } from '../../ui/Ambient';
import { Icon } from '../../ui/Icon';
import { Slider } from '../../ui/Slider';
import { Preview } from './Preview';

export function AppearanceSettings() {
  const { appearance, set } = useAppearance();
  const live = useTheme(); // the app's theme (it knows "reduce transparency")
  const [dragging, setDragging] = useState<number | null>(null); // the glass amount while the slider moves
  const shown = dragging ?? appearance.glass;
  const preview = useMemo(
    () => (dragging === null ? live : resolveTheme({ ...appearance, glass: dragging })),
    [dragging, live, appearance],
  );
  return (
    <View style={styles.page}>
      <Preview theme={preview} />

      <Heading>Theme</Heading>
      <View style={styles.tiles} accessibilityRole="radiogroup">
        {PRESETS.map((p) => (
          <ThemeTile key={p.id} preset={p} on={appearance.theme === p.id} onPress={() => set({ theme: p.id })} />
        ))}
      </View>

      <Heading>My messages</Heading>
      <Swatches value={appearance.myBubble} themeDefault={live.preset.accent} onPick={(id) => set({ myBubble: id })} who="my messages" />

      <Heading>EDITH’s messages</Heading>
      <Swatches value={appearance.edithBubble} themeDefault={INK_LIGHT} onPick={(id) => set({ edithBubble: id })} who="EDITH’s messages" />

      <Heading>Background</Heading>
      <Backgrounds appearance={appearance} onPick={(id) => set({ background: id })} />

      <Heading>Glass</Heading>
      <View style={styles.glassRow}>
        <Icon name="square-rounded-outline" size={18} color={colors.textDim} />
        <View style={styles.flex}>
          <Slider
            value={shown / 100}
            step={0.05}
            label="Glass"
            valueText={(v) => `${Math.round(v * 100)} percent`}
            onMove={(v) => setDragging(Math.round(v * 100))}
            onChange={(v) => {
              set({ glass: Math.round(v * 100) });
              setDragging(null);
            }}
          />
        </View>
        <Text style={styles.value} accessibilityElementsHidden importantForAccessibility="no">
          {shown}%
        </Text>
      </View>
      <Text style={styles.hint}>
        0% is flat and solid: fastest, easiest to read. 100% is the most blur and bend. {DEFAULT_GLASS}% is the original look.
        {live.glass === 0 && appearance.glass > 0 ? ' Your phone asks for less transparency, so glass is off.' : ''}
      </Text>
      {appearance.glass !== DEFAULT_GLASS ? (
        <Pressable onPress={() => set({ glass: DEFAULT_GLASS })} accessibilityRole="button" accessibilityLabel={`Glass back to ${DEFAULT_GLASS}%`} style={styles.reset} hitSlop={8}>
          <Text style={[styles.resetText, { color: live.accent }]}>Back to {DEFAULT_GLASS}%</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <Text style={styles.heading} accessibilityRole="header">
      {children}
    </Text>
  );
}

// Each theme's tile: its own background (with its glow) and accent, drawn once.
const TILE_LOOKS = new Map(PRESETS.map((p) => [p.id, backgroundLook(p, DEFAULT_APPEARANCE.background)]));

const ThemeTile = memo(function ThemeTile({ preset: p, on, onPress }: { preset: ThemePreset; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.tile} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`${p.name} theme`}>
      <View style={[styles.tileArt, on && { borderColor: p.accent, borderWidth: 2 }]}>
        <Ambient look={TILE_LOOKS.get(p.id)} />
        <View style={[styles.tileDot, { backgroundColor: p.accent }]} />
        {on ? <Icon name="check" size={14} color={colors.text} /> : null}
      </View>
      <Text style={[styles.tileName, on && styles.on]} numberOfLines={1}>
        {p.name}
      </Text>
    </Pressable>
  );
});

function Swatches({ value, themeDefault, onPick, who }: { value: string | null; themeDefault: string; onPick: (id: string | null) => void; who: string }) {
  const { bg } = useTheme(); // what a translucent swatch sits on
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup">
      <Swatch color={withAlpha(themeDefault, 0.35)} ground={bg} on={value === null} onPress={() => onPick(null)} label={`Theme default for ${who}`} auto />
      {SWATCHES.map((s) => (
        <Swatch key={s.id} color={s.color} ground={bg} on={value === s.id} onPress={() => onPick(s.id)} label={`${s.name} for ${who}`} />
      ))}
    </View>
  );
}

const Swatch = memo(function Swatch({ color, ground, on, onPress, label, auto }: { color: string; ground: string; on: boolean; onPress: () => void; label: string; auto?: boolean }) {
  const mark = inkOn(color, ground); // black on yellow, white on blue: whichever reads best
  return (
    <Pressable onPress={onPress} hitSlop={4} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={label} style={[styles.ring, on && styles.ringOn]}>
      <View style={[styles.swatch, { backgroundColor: color }]}>
        {auto ? <Icon name="auto-fix" size={14} color={mark} /> : on ? <Icon name="check" size={14} color={mark} /> : null}
      </View>
    </Pressable>
  );
});

function Backgrounds({ appearance, onPick }: { appearance: Appearance; onPick: (id: BackgroundId) => void }) {
  // Each choice drawn in the current theme's colours (the same Ambient the app draws).
  const { preset } = useTheme();
  const looks = useMemo(() => BACKGROUNDS.map((b) => ({ ...b, look: backgroundLook(preset, b.id) })), [preset]);
  return (
    <View style={styles.tiles} accessibilityRole="radiogroup">
      {looks.map((b) => {
        const on = appearance.background === b.id;
        return (
          <Pressable key={b.id} onPress={() => onPick(b.id)} style={styles.tile} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`${b.name} background`}>
            <View style={[styles.tileArt, on && styles.tileOn]}>
              <Ambient look={b.look} />
            </View>
            <Text style={[styles.tileName, on && styles.on]}>{b.name}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const SWATCH = 30;
const TILE = 64;

const styles = StyleSheet.create({
  page: { gap: space.s },
  flex: { flex: 1 },
  heading: { color: colors.textDim, fontSize: type.size.caption, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase', marginTop: space.m },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: space.m },
  tile: { width: TILE, alignItems: 'center', gap: space.xs },
  tileArt: { width: TILE, height: TILE, borderRadius: radius.m, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  tileOn: { borderWidth: 2, borderColor: colors.text },
  tileDot: { position: 'absolute', right: 8, bottom: 8, width: 12, height: 12, borderRadius: 6 },
  tileName: { color: colors.textDim, fontSize: type.size.caption },
  on: { color: colors.text, fontWeight: '700' },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s },
  ring: { padding: 2, borderRadius: (SWATCH + 8) / 2, borderWidth: 2, borderColor: 'transparent' },
  ringOn: { borderColor: colors.text },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2, alignItems: 'center', justifyContent: 'center' },
  glassRow: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  value: { color: colors.text, fontSize: type.size.body, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'right' },
  hint: { color: colors.textDim, fontSize: type.size.small },
  reset: { alignSelf: 'flex-start' },
  resetText: { fontSize: type.size.small, fontWeight: '600' },
});
