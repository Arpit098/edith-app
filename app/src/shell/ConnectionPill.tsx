// The connection dot in the header, used only when no feature puts its own chip there (the live
// session's status chip carries the same dot).

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { describeLink, LINK_TONE, type Connection, type ConnectionState } from '../core/connection';
import { shallowEqual, useStore } from '../core/store';
import { colors, space } from '../core/theme';

export { describeLink };

const selectPill = (s: ConnectionState) => ({ link: s.link, error: s.error, retryInMs: s.retryInMs });

/** A dot (and a word when not connected). Tap to retry now, or open Settings when the token is bad. */
export const ConnectionPill = memo(function ConnectionPill({ connection, onUnauthorized }: { connection: Connection; onUnauthorized: () => void }) {
  const s = useStore(connection.store, selectPill, shallowEqual);
  const press = () => (s.link === 'unauthorized' ? onUnauthorized() : s.link !== 'open' ? connection.retry() : undefined);
  return (
    <Pressable onPress={press} hitSlop={8} accessibilityRole="button" accessibilityLabel={describeLink(s)} style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: colors[LINK_TONE[s.link]] }]} />
      {s.link !== 'open' ? <Text style={styles.text}>{s.link === 'unauthorized' ? 'Bad token' : s.link === 'offline' ? 'Offline' : 'Connecting'}</Text> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.s, paddingVertical: space.xs },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { color: colors.textDim, fontSize: 12 },
});
