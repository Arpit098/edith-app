// The approvals on their own screen: where an approval notification or the Live Alerts pill opens.

import { ScrollView, StyleSheet, View } from 'react-native';

import { useStore } from '../../core/store';
import { space, useChrome } from '../../core/theme';
import { Empty } from '../../ui/Empty';
import { ApprovalsBanner } from './ApprovalsBanner';
import type { ApprovalsModel, ApprovalsState } from './model';

const selectCount = (s: ApprovalsState) => s.pending.length;

export function ApprovalsScreen({ model }: { model: ApprovalsModel }) {
  const count = useStore(model.store, selectCount);
  const chromeInsets = useChrome(); // the floating header and the gesture area
  const insets = { paddingTop: chromeInsets.top + space.m, paddingBottom: chromeInsets.bottom + space.l };
  if (!count) {
    return (
      <View style={[styles.list, insets]}>
        <Empty icon="shield-check-outline" title="Nothing waiting for approval" />
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={[styles.list, insets]}>
      <ApprovalsBanner model={model} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { flexGrow: 1 },
});
