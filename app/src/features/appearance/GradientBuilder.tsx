// "Custom…": the gradient builder, for a background (2–4 stops, linear or radial, an intensity) or a
// bubble (2 stops). Each stop's colour comes from a palette or the hue and brightness sliders; the
// direction from 8 arrows or the angle slider. Every change goes to `onChange` at once, so the page's
// preview shows the draft live; nothing is kept until Save.
//
// Readability isn't left to the colours picked: a background's stops are dimmed to its intensity's
// cap and a bubble's tint is fitted for its text (core/theme), so any choice here stays at 4.5:1.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, DIRECTIONS, hexToHsv, hsvToHex, MAX_STOPS, radius, space, STOP_PALETTE, type, useTheme, type GradientSpec } from '../../core/theme';
import { Button } from '../../ui/Button';
import { Gradient } from '../../ui/Gradient';
import { Icon } from '../../ui/Icon';
import { Slider } from '../../ui/Slider';
import { Heading, Hint, shared, Swatch } from './parts';

export interface GradientBuilderProps {
  mode: 'background' | 'bubble';
  value: GradientSpec;
  onChange: (spec: GradientSpec) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
  title: string;
}

export function GradientBuilder({ mode, value: spec, onChange, onSave, onCancel, onDelete, title }: GradientBuilderProps) {
  const [picked, setPicked] = useState(0); // the stop being coloured
  const at = Math.min(picked, spec.stops.length - 1);
  const stop = spec.stops[at]!;
  const hsv = hexToHsv(stop);
  const most = mode === 'bubble' ? 2 : MAX_STOPS;
  const change = (c: Partial<GradientSpec>) => onChange({ ...spec, ...c });
  const colour = (hex: string) => change({ stops: spec.stops.map((s, i) => (i === at ? hex : s)) });

  return (
    <View style={styles.box} testID={`builder-${mode}`}>
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <Gradient colors={spec.stops} angle={spec.angle} style={styles.strip} />

      <Heading>Colour stops</Heading>
      <View style={styles.stops} accessibilityRole="radiogroup">
        {spec.stops.map((s, i) => (
          <Swatch key={i} colors={[s]} on={i === at} onPress={() => setPicked(i)} label={`Stop ${i + 1} of ${spec.stops.length}`} />
        ))}
        {spec.stops.length < most ? (
          <Pressable
            onPress={() => {
              change({ stops: [...spec.stops, spec.stops[spec.stops.length - 1]!] });
              setPicked(spec.stops.length);
            }}
            style={styles.round}
            accessibilityRole="button"
            accessibilityLabel="Add a colour stop"
            hitSlop={4}
          >
            <Icon name="plus" size={18} color={colors.text} />
          </Pressable>
        ) : null}
        {spec.stops.length > 2 ? (
          <Pressable
            onPress={() => {
              change({ stops: spec.stops.filter((_, i) => i !== at) });
              setPicked(Math.max(0, at - 1));
            }}
            style={styles.round}
            accessibilityRole="button"
            accessibilityLabel={`Remove stop ${at + 1}`}
            hitSlop={4}
          >
            <Icon name="minus" size={18} color={colors.text} />
          </Pressable>
        ) : null}
      </View>
      <View style={shared.row}>
        {STOP_PALETTE.map((p) => (
          <Swatch key={p.color} colors={[p.color]} on={p.color === stop} onPress={() => colour(p.color)} label={`${p.name} for stop ${at + 1}`} />
        ))}
      </View>
      <Labelled icon="palette-outline" label={`Hue, stop ${at + 1}`} value={`${hsv.h}°`}>
        <Slider value={hsv.h / 360} step={1 / 36} label={`Hue, stop ${at + 1}`} valueText={(v) => `${Math.round(v * 360)} degrees`} onChange={(v) => colour(hsvToHex(v * 360, Math.max(hsv.s, 0.6), Math.max(hsv.v, 0.3)))} />
      </Labelled>
      <Labelled icon="brightness-6" label={`Brightness, stop ${at + 1}`} value={`${Math.round(hsv.v * 100)}%`}>
        <Slider value={hsv.v} step={0.05} label={`Brightness, stop ${at + 1}`} onChange={(v) => colour(hsvToHex(hsv.h, hsv.s, v))} />
      </Labelled>

      <Heading>Direction</Heading>
      <View style={shared.row} accessibilityRole="radiogroup">
        {DIRECTIONS.map((d) => {
          const on = d.angle === spec.angle;
          return (
            <Pressable key={d.angle} onPress={() => change({ angle: d.angle })} style={[styles.round, on && styles.roundOn]} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`Direction ${d.name}`} hitSlop={4}>
              <Icon name={d.icon} size={18} color={on ? colors.text : colors.textDim} />
            </Pressable>
          );
        })}
      </View>
      <Labelled icon="angle-acute" label="Angle" value={`${spec.angle}°`}>
        <Slider value={spec.angle / 359} step={5 / 359} label="Angle" valueText={(v) => `${Math.round(v * 359)} degrees`} onChange={(v) => change({ angle: Math.round(v * 359) })} />
      </Labelled>

      {mode === 'background' ? (
        <>
          <Heading>Type</Heading>
          <View style={styles.segments} accessibilityRole="radiogroup">
            {(['linear', 'radial'] as const).map((k) => (
              <Segment key={k} label={k === 'linear' ? 'Linear' : 'Radial'} on={spec.kind === k} onPress={() => change({ kind: k })} />
            ))}
          </View>
          <Heading>Intensity</Heading>
          <Labelled icon="weather-night" label="Intensity" value={`${spec.intensity}%`}>
            <Slider value={spec.intensity / 100} step={0.05} label="Intensity" onChange={(v) => change({ intensity: Math.round(v * 100) })} />
          </Labelled>
          <Hint>Lower is darker. Bright colours are always dimmed enough for text to stay easy to read.</Hint>
        </>
      ) : (
        <Hint>The text on these bubbles stays readable: the colours are toned down as much as needed.</Hint>
      )}

      <View style={styles.actions}>
        <Button label="Save" variant="primary" small onPress={onSave} accessibilityLabel={`Save ${title.toLowerCase()}`} />
        <Button label="Cancel" small onPress={onCancel} />
        {onDelete ? <Button label="Delete" variant="danger" small onPress={onDelete} accessibilityLabel={`Delete ${title.toLowerCase()}`} /> : null}
      </View>
    </View>
  );
}

function Labelled({ icon, label, value, children }: { icon: string; label: string; value: string; children: React.ReactNode }) {
  return (
    <View style={styles.labelled}>
      <Icon name={icon} size={18} color={colors.textDim} />
      <View style={shared.flex} accessibilityLabel={label}>
        {children}
      </View>
      <Text style={styles.value} accessibilityElementsHidden importantForAccessibility="no">
        {value}
      </Text>
    </View>
  );
}

function Segment({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { accentSoft } = useTheme();
  return (
    <Pressable onPress={onPress} style={[styles.segment, on && { backgroundColor: accentSoft, borderColor: colors.text }]} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`${label} gradient`}>
      <Text style={[styles.segmentText, on && styles.segmentOn]}>{label}</Text>
    </Pressable>
  );
}

const ROUND = 34;

const styles = StyleSheet.create({
  box: { gap: space.s, padding: space.m, borderRadius: radius.m, backgroundColor: colors.cardRaised },
  title: { color: colors.text, fontSize: type.size.body, fontWeight: '700' },
  strip: { height: 28, borderRadius: radius.s },
  stops: { flexDirection: 'row', flexWrap: 'wrap', gap: space.s, alignItems: 'center' },
  round: { width: ROUND, height: ROUND, borderRadius: ROUND / 2, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  roundOn: { borderWidth: 2, borderColor: colors.text },
  labelled: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  value: { color: colors.text, fontSize: type.size.small, fontVariant: ['tabular-nums'], minWidth: 44, textAlign: 'right' },
  segments: { flexDirection: 'row', gap: space.s },
  segment: { paddingHorizontal: space.l, paddingVertical: space.s, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  segmentText: { color: colors.textDim, fontSize: type.size.small },
  segmentOn: { color: colors.text, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: space.s, marginTop: space.s },
});
