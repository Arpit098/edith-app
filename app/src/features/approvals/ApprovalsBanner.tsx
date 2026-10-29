// Pending permission prompts, shown above every screen until answered (here or elsewhere).

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { PendingPermission } from '../../core/api';
import { useStore } from '../../core/store';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { colors, mono, radius, space } from '../../ui/theme';
import { toast } from '../../ui/toast';
import type { ApprovalsModel, ApprovalsState } from './model';

const selectPending = (s: ApprovalsState) => s.pending;
const selectAnswering = (s: ApprovalsState) => s.answering;

export function ApprovalsBanner({ model }: { model: ApprovalsModel }) {
  const pending = useStore(model.store, selectPending);
  const answering = useStore(model.store, selectAnswering);
  if (!pending.length) return null;
  return (
    <View style={styles.wrap}>
      {pending.map((p) => (
        <Card key={p.id} p={p} busy={!!answering[p.id]} model={model} />
      ))}
    </View>
  );
}

const Card = memo(function Card({ p, busy, model }: { p: PendingPermission; busy: boolean; model: ApprovalsModel }) {
  const answer = (allow: boolean) => void model.answer(p.id, allow).then(toast);
  return (
    <View style={styles.card} accessibilityRole="alert">
      <View style={styles.head}>
        <Icon name="shield-alert-outline" size={18} color={colors.warn} />
        <Text style={styles.title}>
          Approve {p.tool}?{p.lane === 'side' ? ' (parallel task)' : ''}
        </Text>
      </View>
      {p.detail ? (
        <Text style={styles.detail} numberOfLines={6} selectable>
          {p.detail}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button label="Deny" variant="danger" small onPress={() => answer(false)} disabled={busy} />
        <Button label="Allow" variant="primary" small onPress={() => answer(true)} busy={busy} />
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { padding: space.s, gap: space.s, backgroundColor: colors.bg },
  card: { backgroundColor: colors.surfaceHigh, borderRadius: radius.m, padding: space.m, borderWidth: 1, borderColor: colors.warn },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.s },
  title: { color: colors.text, fontWeight: '700', fontSize: 15, flex: 1 },
  detail: { color: colors.text, fontFamily: mono, fontSize: 12, marginTop: space.s },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.s, marginTop: space.m },
});
