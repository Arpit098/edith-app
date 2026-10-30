// A small 0..1 slider (React Native has none built in): drag or tap the track; TalkBack adjusts it
// in steps. While dragging it moves on its own; `onChange` runs once, on release. Theme tokens only.

import { memo, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

import { colors, space } from '../../ui/theme';

const THUMB = 22;

export const Slider = memo(function Slider({ value, onChange, step = 0.05, label }: { value: number; onChange: (v: number) => void; step?: number; label: string }) {
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<number | null>(null);
  const geometry = useRef({ width: 0, onChange, drag: null as number | null });
  geometry.current = { width, onChange, drag: geometry.current.drag };

  const responder = useMemo(() => {
    const set = (x: number) => {
      const w = geometry.current.width - THUMB;
      if (w <= 0) return;
      const v = Math.min(1, Math.max(0, (x - THUMB / 2) / w));
      geometry.current.drag = v;
      setDrag(v);
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

  const shown = drag ?? value;
  const left = Math.max(0, width - THUMB) * shown;
  return (
    <View
      style={styles.box}
      onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(shown * 100) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onChange(Math.min(1, Math.max(0, value + (e.nativeEvent.actionName === 'increment' ? step : -step))))}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={styles.track}>
        <View style={[styles.fill, { width: left + THUMB / 2 }]} />
      </View>
      <View pointerEvents="none" style={[styles.thumb, { left }]} />
    </View>
  );
});

const styles = StyleSheet.create({
  box: { height: THUMB + space.m, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.border, marginHorizontal: THUMB / 2, overflow: 'hidden' },
  fill: { height: 4, backgroundColor: colors.accent, marginLeft: -THUMB / 2 },
  thumb: { position: 'absolute', width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.bg },
});
