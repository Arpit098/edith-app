// "EDITH is working…" at the bottom of the chat, with what it's doing when known. Shown only while
// a turn runs, with the glass blob (ui/WorkingBlob) as its indicator.

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useStore } from '../../core/store';
import { colors, space, type } from '../../core/theme';
import { WorkingBlob } from '../../ui/WorkingBlob';
import { workingLabel, type LiveModel } from './model';

export const WorkingRow = memo(function WorkingRow({ model }: { model: LiveModel }) {
  const label = useStore(model.store, workingLabel);
  if (!label) return null;
  return (
    <View style={styles.row} accessibilityLiveRegion="polite" accessibilityLabel={`EDITH is working: ${label}`}>
      <WorkingBlob />
      <Text style={styles.text} numberOfLines={1}>
        {label}…
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.s, paddingVertical: space.s, paddingHorizontal: space.xs },
  text: { color: colors.textDim, fontSize: type.size.small, flex: 1 },
});
