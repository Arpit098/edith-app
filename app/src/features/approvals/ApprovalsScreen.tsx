// The approvals on their own screen: where an approval notification or the Live Alerts pill opens.

import { ScrollView, StyleSheet } from 'react-native';

import { useStore } from '../../core/store';
import { Empty } from '../../ui/Empty';
import { ApprovalsBanner } from './ApprovalsBanner';
import type { ApprovalsModel, ApprovalsState } from './model';

const selectCount = (s: ApprovalsState) => s.pending.length;

export function ApprovalsScreen({ model }: { model: ApprovalsModel }) {
  const count = useStore(model.store, selectCount);
  if (!count) return <Empty icon="shield-check-outline" title="Nothing waiting for approval" />;
  return (
    <ScrollView contentContainerStyle={styles.list}>
      <ApprovalsBanner model={model} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1 },
});
