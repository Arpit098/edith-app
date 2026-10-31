// A small "Update ready · Restart" banner above every screen, for an update not seen yet: the fallback
// when push is off (contracts/app-updates.md §7). Dismissing it, or acting on it, marks it seen.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useStore } from '../../core/store';
import { colors, radius, space, type } from '../../core/theme';
import { Button } from '../../ui/Button';
import { Icon } from '../../ui/Icon';
import { updateBanner, type AppUpdateModel, type AppUpdateState } from './model';

const selectRestarting = (s: AppUpdateState) => s.restarting;

export function UpdateBanner({ model, openUpdates }: { model: AppUpdateModel; openUpdates: () => void }) {
  const banner = useStore(model.store, updateBanner);
  const restarting = useStore(model.store, selectRestarting);
  if (!banner) return null;
  const act = () => {
    if (banner.action === 'restart') {
      void model.restartToUpdate();
      return;
    }
    model.markSeen();
    openUpdates();
  };
  return (
    <View style={styles.wrap}>
      <View style={styles.card} accessibilityRole="alert">
        <Icon name="cellphone-arrow-down" size={18} color={colors.accent} />
        <Text style={styles.text} numberOfLines={1}>
          {banner.text}
        </Text>
        <Button small variant="primary" label={banner.action === 'restart' ? 'Restart' : 'Open'} busy={restarting} onPress={act} />
        <Pressable onPress={() => model.markSeen()} hitSlop={10} accessibilityRole="button" accessibilityLabel="Dismiss">
          <Icon name="close" size={18} color={colors.textDim} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: space.m, paddingBottom: space.m }, // inside the glass header
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.s,
    backgroundColor: colors.cardRaised,
    borderRadius: radius.m,
    paddingVertical: space.s,
    paddingHorizontal: space.m,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.accent,
  },
  text: { color: colors.text, fontSize: type.size.body, fontWeight: '600', flex: 1 },
});
