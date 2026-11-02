// A slim pill above every screen while the backup AI answers instead of Claude.

import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type } from '../../core/theme';
import { useStore } from '../../core/store';
import { Icon } from '../../ui/Icon';
import { pillText, type BackupModel } from './model';

export function BackupPill({ model }: { model: BackupModel }) {
  const text = useStore(model.store, pillText);
  if (!text) return null;
  return (
    <View style={styles.wrap}>
      <View style={styles.pill} accessibilityRole="summary">
        <Icon name="lifebuoy" size={16} color={colors.warn} />
        <Text style={styles.text} numberOfLines={2}>
          {text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.m, paddingBottom: space.s },
  pill: { flexDirection: 'row', alignItems: 'center', gap: space.s, backgroundColor: colors.warnSoft, borderRadius: radius.m, paddingHorizontal: space.m, paddingVertical: space.s },
  text: { color: colors.text, fontSize: type.size.caption + 1, flex: 1 },
});
