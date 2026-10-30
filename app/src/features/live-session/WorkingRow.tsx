// "EDITH is working…" at the bottom of the chat, with what it's doing when known. Shown only while
// a turn runs. The dots animate on the native driver (no JS per frame) and stay still when Android's
// "remove animations" is on. Phase 2b replaces the dots with a glass blob.

import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { useStore } from '../../core/store';
import { colors, space } from '../../core/theme';
import { workingLabel, type LiveModel } from './model';

const DOTS = 3;

export const WorkingRow = memo(function WorkingRow({ model }: { model: LiveModel }) {
  const label = useStore(model.store, workingLabel);
  if (!label) return null;
  return (
    <View style={styles.row} accessibilityLiveRegion="polite" accessibilityLabel={`EDITH is working: ${label}`}>
      <Dots />
      <Text style={styles.text} numberOfLines={1}>
        {label}…
      </Text>
    </View>
  );
});

function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce, () => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduce);
    return () => sub.remove();
  }, []);
  return reduce;
}

const Dots = memo(function Dots() {
  const reduce = useReduceMotion();
  const phase = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(Animated.timing(phase, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }));
    loop.start();
    return () => loop.stop(); // nothing runs once the row is gone
  }, [phase, reduce]);
  return (
    <View style={styles.dots}>
      {Array.from({ length: DOTS }, (_, i) => {
        const start = i / (DOTS + 1);
        const opacity = reduce
          ? 0.7
          : phase.interpolate({ inputRange: [0, start, start + 0.25, 1], outputRange: [0.3, 0.3, 1, 0.3], extrapolate: 'clamp' });
        return <Animated.View key={i} style={[styles.dot, { opacity }]} />;
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: space.s, paddingHorizontal: space.xs },
  dots: { flexDirection: 'row', gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.accent },
  text: { color: colors.textDim, fontSize: 13, flex: 1 },
});
