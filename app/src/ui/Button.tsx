import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from './Icon';
import { colors, radius, space } from './theme';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps {
  label?: string;
  icon?: string;
  onPress: () => void;
  variant?: Variant;
  small?: boolean;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
}

const fg: Record<Variant, string> = { primary: colors.accentText, secondary: colors.text, danger: '#fff', ghost: colors.accent };
const bg: Record<Variant, string> = { primary: colors.accent, secondary: colors.surfaceHigh, danger: colors.danger, ghost: 'transparent' };

export const Button = memo(function Button({ label, icon, onPress, variant = 'secondary', small, disabled, busy, accessibilityLabel }: ButtonProps) {
  const off = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      android_ripple={{ color: '#ffffff22' }}
      style={[styles.base, small && styles.small, { backgroundColor: bg[variant], opacity: off ? 0.5 : 1 }]}
    >
      <View style={styles.row}>
        {busy ? <ActivityIndicator size="small" color={fg[variant]} /> : icon ? <Icon name={icon} size={small ? 16 : 20} color={fg[variant]} /> : null}
        {label ? <Text style={[styles.label, small && styles.smallLabel, { color: fg[variant] }]}>{label}</Text> : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  base: { borderRadius: radius.m, paddingHorizontal: space.l, paddingVertical: space.m, overflow: 'hidden', minHeight: 44, justifyContent: 'center' },
  small: { paddingHorizontal: space.m, paddingVertical: space.xs + 2, minHeight: 34, borderRadius: radius.s },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.s },
  label: { fontSize: 16, fontWeight: '600' },
  smallLabel: { fontSize: 14 },
});
