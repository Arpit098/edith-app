import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Icon } from './Icon';
import { colors, space } from '../core/theme';

export const Empty = memo(function Empty({ icon, title, detail }: { icon: string; title: string; detail?: string }) {
  return (
    <View style={styles.box}>
      <Icon name={icon} size={40} color={colors.textDim} />
      <Text style={styles.title}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center', padding: space.xl, gap: space.s, flex: 1 },
  title: { color: colors.text, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  detail: { color: colors.textDim, fontSize: 14, textAlign: 'center' },
});
