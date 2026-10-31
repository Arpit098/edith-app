// The Tools launcher: one tile per feature `tool` (PLAN.md §4.4).

import { memo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import type { Tool } from '../core/feature';
import { colors, radius, space, type, useChrome, useTheme } from '../core/theme';
import { Empty } from '../ui/Empty';
import { Glass } from '../ui/Glass';
import { Icon } from '../ui/Icon';

const TILE_MIN = 104;
const keyOf = (t: Tool) => t.screen;

export function ToolsScreen({ tools, open }: { tools: Tool[]; open: (screen: string) => void }) {
  const { width } = useWindowDimensions();
  const chromeInsets = useChrome();
  const columns = Math.max(2, Math.floor((width - space.l * 2) / TILE_MIN));
  if (!tools.length) {
    return (
      <View style={[styles.flex, { paddingTop: chromeInsets.top, paddingBottom: chromeInsets.bottom }]}>
        <Empty icon="toolbox-outline" title="No tools yet" detail="Each feature with a tool adds a tile here." />
      </View>
    );
  }
  return (
    <FlatList
      key={columns} // numColumns can't change on the fly
      data={tools}
      numColumns={columns}
      keyExtractor={keyOf}
      renderItem={({ item }) => <Tile tool={item} open={open} />}
      contentContainerStyle={[styles.grid, { paddingTop: chromeInsets.top + space.l, paddingBottom: chromeInsets.bottom + space.l }]}
      columnWrapperStyle={styles.row}
    />
  );
}

/** A glass tile (flat: tiles sit in a list, so they don't blur). */
const Tile = memo(function Tile({ tool, open }: { tool: Tool; open: (screen: string) => void }) {
  const theme = useTheme();
  return (
    <Glass level="thin" radius={radius.l} style={styles.tile}>
      <Pressable style={styles.press} onPress={() => open(tool.screen)} android_ripple={{ color: colors.ripple }} accessibilityRole="button" accessibilityLabel={tool.title}>
        <View style={[styles.iconWell, { backgroundColor: theme.accentSoft }]}>
          <Icon name={tool.icon} size={28} color={theme.accent} />
        </View>
        <Text style={styles.label} numberOfLines={2}>
          {tool.title}
        </Text>
      </Pressable>
    </Glass>
  );
});

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grid: { paddingHorizontal: space.l, gap: space.m },
  row: { gap: space.m },
  tile: { flex: 1, aspectRatio: 1, maxWidth: 160 },
  press: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.s, padding: space.s },
  iconWell: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  label: { color: colors.text, fontSize: type.size.small, fontWeight: '600', textAlign: 'center' },
});
