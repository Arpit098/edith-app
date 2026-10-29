// The app's backdrop: near-black with two soft glows of the logo's blue, so the glass has
// something to catch. Static gradients: drawn once, no animation, no cost while scrolling.

import { LinearGradient } from 'expo-linear-gradient';
import { memo } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from '../core/theme';

export const Ambient = memo(function Ambient() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.bg]} pointerEvents="none">
      <LinearGradient colors={[colors.ambient, colors.ambientFar]} start={{ x: 0, y: 0 }} end={{ x: 0.75, y: 0.55 }} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={[colors.ambientFar, colors.ambient]} start={{ x: 0.3, y: 0.55 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, styles.far]} />
    </View>
  );
});

const styles = StyleSheet.create({
  bg: { backgroundColor: colors.bg },
  far: { opacity: 0.6 },
});
