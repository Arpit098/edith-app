// A small 0..1 slider (React Native has none built in): drag or tap the track; TalkBack adjusts it
// in steps. While dragging it moves on its own and reports each position to `onMove` (if given, e.g.
// to preview the glass amount live); `onChange` runs once, on release. In the theme's accent.

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { colors, space, themedStyles } from '../core/theme';

const THUMB = 22;

export interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  onMove?: (v: number) => void;
  step?: number;
  label: string;
  /** How TalkBack reads the value (default: "<n> percent"). */
  valueText?: (v: number) => string;
}

export const Slider = memo(function Slider({ value, onChange, onMove, step = 0.05, label, valueText }: SliderProps) {
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const geometry = useRef({ width: 0, onChange, onMove, drag: null as number | null });
  geometry.current = { width, onChange, onMove, drag: geometry.current.drag };
  const ts = useStyles();

  const responder = useMemo(() => {
    const set = (x: number) => {
      const w = geometry.current.width - THUMB;
      if (w <= 0) return;
      const v = Math.min(1, Math.max(0, (x - THUMB / 2) / w));
      geometry.current.drag = v;
      setDrag(v);
      geometry.current.onMove?.(v);
    };
    const commit = () => {
      const v = geometry.current.drag;
      geometry.current.drag = null;
      setDrag(null);
      if (v !== null) geometry.current.onChange(v);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => set(e.nativeEvent.locationX),
      onPanResponderMove: (e) => set(e.nativeEvent.locationX),
      onPanResponderRelease: commit,
      onPanResponderTerminate: commit,
      onPanResponderTerminationRequest: () => false,
    });
  }, []);

  // Taken away mid-drag (its page closed, its tool switched): the value reached still counts.
  useEffect(
    () => () => {
      const v = geometry.current.drag;
      geometry.current.drag = null;
      if (v !== null) geometry.current.onChange(v);
    },
    [],
  );

  const shown = drag ?? value;
  const left = Math.max(0, width - THUMB) * shown;
  return (
    <View
      style={styles.box}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100), text: valueText?.(shown) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(Math.min(1, Math.max(0, value + (e.nativeEvent.actionName === 'increment' ? step : -step))))}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={styles.track}>
        <View style={[styles.fill, ts.fill, { width: left + THUMB / 2 }]} />
      </View>
      <View pointerEvents="none" style={[styles.thumb, ts.thumb, { left }]} />
    </View>
  );
});

const styles = StyleSheet.create({
  box: { height: THUMB + space.m, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.hairline, marginHorizontal: THUMB / 2, overflow: 'hidden' },
  fill: { height: 4, marginLeft: -THUMB / 2 },
  thumb: { position: 'absolute', width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 2 },
});

const useStyles = themedStyles((t) =>
  StyleSheet.create({
    fill: { backgroundColor: t.accent },
    thumb: { backgroundColor: t.accent, borderColor: t.bg },
  }),
);
