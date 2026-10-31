// Navigation (Arpit's request, replacing the bottom tab bar): a hamburger at the top right of the
// header opens a glass drop-down sheet listing the main screens, the current one marked. It grows
// out of the button on a spring and shrinks back into it; a tap outside or Android's back closes it.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { colors, legibleText, motion, radius, space, type } from '../core/theme';
import { Glass } from '../ui/Glass';
import { Icon } from '../ui/Icon';
import { Squish, useReduceMotion } from '../ui/motion';

export interface MenuItem {
  name: string;
  title: string;
  icon: string;
}

export const TOUCH = 44; // dp: the smallest comfortable touch target

/** The hamburger: 44 dp, labelled, says whether the menu is open. */
export const MenuButton = memo(function MenuButton({ open, onPress }: { open: boolean; onPress: () => void }) {
  return (
    <Squish
      onPress={onPress}
      outerStyle={styles.button}
      style={styles.buttonInner}
      accessibilityRole="button"
      accessibilityLabel={open ? 'Close the menu' : 'Menu'}
      accessibilityState={{ expanded: open }}
    >
      <Icon name={open ? 'close' : 'menu'} size={24} color={colors.text} />
    </Squish>
  );
});

export interface NavMenuProps {
  open: boolean;
  items: MenuItem[];
  current: string | null; // the screen shown (null: a screen that isn't in the menu)
  top: number; // just under the header
  backdrop: number | null; // what the sheet's glass bends
  onSelect: (name: string) => void;
  onClose: () => void;
}

/**
 * The sheet. It stays mounted until its closing spring has settled (then unmounts, so a closed
 * menu costs nothing). Its glass reuses a compiled lens shader (edith-glass keeps a small pool), so
 * opening it never compiles one again.
 */
export function NavMenu({ open, items, current, top, backdrop, onSelect, onClose }: NavMenuProps) {
  const reduce = useReduceMotion();
  const [mounted, setMounted] = useState(open);
  const p = useSharedValue(0);
  // Read when the closing spring ends: opened again meanwhile, it stays mounted.
  const openNow = useRef(open);
  openNow.current = open;
  const unmountIfClosed = useCallback(() => {
    if (!openNow.current) setMounted(false);
  }, []);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      p.value = reduce ? 1 : withSpring(1, motion.grow);
    } else if (reduce) {
      p.value = 0;
      setMounted(false);
    } else {
      p.value = withSpring(0, motion.press, (finished) => {
        if (finished) scheduleOnRN(unmountIfClosed);
      });
    }
  }, [open, mounted, reduce, p, unmountIfClosed]);

  // Back closes the menu first (handlers run newest first, so this one beats the shell's).
  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [open, onClose]);

  const sheet = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 1.5),
    transform: [{ scale: 0.55 + 0.45 * p.value }],
  }));

  if (!mounted) return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? 'box-none' : 'none'}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close the menu" importantForAccessibility="no" />
      <Animated.View style={[styles.sheetSlot, { top, transformOrigin: 'right top' }, sheet]}>
        <Glass level="panel" backdrop={backdrop} radius={radius.l} rim style={styles.sheet}>
          <View accessibilityRole="menu">
            {items.map((item) => {
              const on = item.name === current;
              return (
                <Squish
                  key={item.name}
                  onPress={() => onSelect(item.name)}
                  style={[styles.item, on && styles.itemOn]}
                  accessibilityRole="menuitem"
                  accessibilityLabel={on ? `${item.title}, current screen` : item.title}
                  accessibilityState={{ selected: on }}
                >
                  <Icon name={item.icon} size={22} color={colors.text} halo />
                  <Text style={[styles.itemText, on && styles.itemTextOn]}>{item.title}</Text>
                  {on ? <Icon name="check" size={18} color={colors.text} halo /> : null}
                </Squish>
              );
            })}
          </View>
        </Glass>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: { width: TOUCH, height: TOUCH, marginRight: -space.s },
  buttonInner: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill },
  sheetSlot: { position: 'absolute', right: space.m, minWidth: 220 },
  sheet: { paddingVertical: space.xs },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.m, minHeight: TOUCH + space.s, paddingHorizontal: space.l, marginHorizontal: space.xs, borderRadius: radius.m },
  itemOn: { backgroundColor: colors.accentSoft },
  // Labels and icons at full opacity, a little heavier, each with the dark halo: the popup is clear
  // glass with no pane behind them. The current screen is marked by the row's tint, weight and check.
  itemText: { color: colors.text, fontSize: type.size.body, fontWeight: '600', flex: 1, ...legibleText },
  itemTextOn: { fontWeight: '700' },
});
