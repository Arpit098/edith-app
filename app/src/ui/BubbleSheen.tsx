// The glass sheen along a chat bubble's top (theme BubbleLook.highlight): one gradient view, none at
// 0% glass (the flat look). The bubble clips it (overflow hidden) to its corners.

import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet } from 'react-native';

import type { BubbleLook } from '../core/theme';

export const BubbleSheen = memo(function BubbleSheen({ look, glass }: { look: BubbleLook; glass: number }) {
  return glass > 0 ? <LinearGradient colors={[look.highlight, 'transparent']} style={styles.sheen} pointerEvents="none" /> : null;
});

const styles = StyleSheet.create({
  sheen: { position: 'absolute', top: 0, left: 0, right: 0, height: 24 },
});
