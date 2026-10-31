// Swipe a row to the right to reply to it (plans/ui-next.md §1). A PanResponder (no gesture
// library: OTA only) claims a drag only once it's clearly sideways (swipe.ts wantsSwipe), so the
// list still scrolls and taps still land. The row follows the finger through a shared value (no
// React render while dragging); past the catch point the reply arrow pops and turns blue, and
// letting go there quotes the message. It springs back on the UI thread, or jumps back with
// "Remove animations" on.
//
// No haptic yet: RN's Vibration needs android.permission.VIBRATE, which app.json blocks, and
// calling it without the permission throws. A tick needs a native change (follow-up).

import { memo, useMemo, useRef, type ReactNode } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { colors, motion, space, useTheme } from '../core/theme';
import { Icon } from './Icon';
import { useReduceMotion } from './motion';
import { caught, swipeOffset, SWIPE, wantsSwipe } from './swipe';

export const SwipeToReply = memo(function SwipeToReply({ onReply, children }: { onReply: () => void; children: ReactNode }) {
  const reduce = useReduceMotion();
  const x = useSharedValue(0);
  // The responder is made once; these keep its callbacks current without making it again.
  const latest = useRef({ onReply, reduce });
  latest.current = { onReply, reduce };

  const responder = useMemo(() => {
    const back = () => {
      x.value = latest.current.reduce ? 0 : withSpring(0, motion.swipe);
    };
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => wantsSwipe(g.dx, g.dy),
      onPanResponderTerminationRequest: () => false, // a swipe in progress keeps the touch (the list doesn't scroll away with it)
      onPanResponderMove: (_, g) => {
        x.value = swipeOffset(g.dx);
      },
      onPanResponderRelease: (_, g) => {
        back();
        if (caught(g.dx)) latest.current.onReply();
      },
      onPanResponderTerminate: back,
    });
  }, [x]);

  const row = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const hint = useAnimatedStyle(() => {
    const p = Math.min(1, x.value / SWIPE.catch);
    const on = x.value >= SWIPE.catch;
    return { opacity: p, transform: [{ scale: on ? 1.15 : 0.6 + 0.3 * p }] };
  });
  const hintOn = useAnimatedStyle(() => ({ opacity: x.value >= SWIPE.catch ? 1 : 0 }));
  const { accent } = useTheme();

  return (
    <View {...responder.panHandlers}>
      <Animated.View style={[styles.hint, hint]} pointerEvents="none" importantForAccessibility="no-hide-descendants">
        <Icon name="reply" size={20} color={colors.textDim} />
        <Animated.View style={[StyleSheet.absoluteFill, styles.center, hintOn]}>
          <Icon name="reply" size={20} color={accent} />
        </Animated.View>
      </Animated.View>
      <Animated.View style={row}>{children}</Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  hint: { position: 'absolute', left: space.xs, top: 0, bottom: 0, width: 28, alignItems: 'center', justifyContent: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
