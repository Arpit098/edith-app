import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Connection, ConnectionState, LinkState } from '../core/connection';
import { shallowEqual, useStore } from '../core/store';
import { colors, space } from '../ui/theme';

const DOT: Record<LinkState, string> = {
  loading: colors.textDim,
  unconfigured: colors.textDim,
  connecting: colors.warn,
  open: colors.ok,
  offline: colors.danger,
  unauthorized: colors.danger,
};

export function describeLink(s: Pick<ConnectionState, 'link' | 'error' | 'retryInMs'>): string {
  switch (s.link) {
    case 'open':
      return 'Connected';
    case 'connecting':
      return 'Connecting…';
    case 'offline': {
      const retry = s.retryInMs ? ` · retrying in ${Math.ceil(s.retryInMs / 1000)}s` : '';
      return `Offline${s.error ? ` (${s.error})` : ''}${retry}`;
    }
    case 'unauthorized':
      return 'The server rejected the token. Change server to enter a new one.';
    case 'loading':
      return 'Loading…';
    case 'unconfigured':
      return 'Not set up';
  }
}

const selectPill = (s: ConnectionState) => ({ link: s.link, error: s.error, retryInMs: s.retryInMs });

/** A dot (and a word when not connected). Tap to retry now, or open Settings when the token is bad. */
export const ConnectionPill = memo(function ConnectionPill({ connection, onUnauthorized }: { connection: Connection; onUnauthorized: () => void }) {
  const s = useStore(connection.store, selectPill, shallowEqual);
  const press = () => (s.link === 'unauthorized' ? onUnauthorized() : s.link !== 'open' ? connection.retry() : undefined);
  return (
    <Pressable onPress={press} hitSlop={8} accessibilityRole="button" accessibilityLabel={describeLink(s)} style={styles.pill}>
      <View style={[styles.dot, { backgroundColor: DOT[s.link] }]} />
      {s.link !== 'open' ? <Text style={styles.text}>{s.link === 'unauthorized' ? 'Bad token' : s.link === 'offline' ? 'Offline' : 'Connecting'}</Text> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingHorizontal: space.s, paddingVertical: space.xs },
  dot: { width: 10, height: 10, borderRadius: 5 },
  text: { color: colors.textDim, fontSize: 12 },
});
