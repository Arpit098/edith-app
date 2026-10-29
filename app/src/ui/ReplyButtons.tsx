// Rows of reply buttons (contracts/events.md, "Replies and buttons"). The owner sends the action.

import { memo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { ButtonRows } from '../core/events';
import { Button } from './Button';
import { space } from './theme';

export const ReplyButtons = memo(function ReplyButtons({ rows, onPress }: { rows: ButtonRows; onPress: (action: string) => Promise<unknown> }) {
  const [pressing, setPressing] = useState<string | null>(null);
  if (!rows.length) return null;
  const press = (action: string) => {
    if (pressing) return;
    setPressing(action);
    onPress(action).finally(() => setPressing(null));
  };
  return (
    <View style={styles.rows}>
      {rows.map((row, i) => (
        <View key={i} style={styles.row}>
          {row.map((b) => (
            <Button key={b.action} small label={b.label} busy={pressing === b.action} disabled={!!pressing} onPress={() => press(b.action)} />
          ))}
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  rows: { marginTop: space.s, gap: space.xs },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
});
