// The Tools launcher: one tile per feature `tool` (PLAN.md §4.4).

import { memo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, useWindowDimensions } from 'react-native';

import type { Tool } from '../core/feature';
import { Empty } from '../ui/Empty';
import { Icon } from '../ui/Icon';
import { colors, radius, space } from '../ui/theme';

const TILE_MIN = 104;
const keyOf = (t: Tool) => t.screen;

export function ToolsScreen({ tools, open }: { tools: Tool[]; open: (screen: string) => void }) {
  const { width } = useWindowDimensions();
  const columns = Math.max(2, Math.floor((width - space.m * 2) / TILE_MIN));
  if (!tools.length) return <Empty icon="toolbox-outline" title="No tools yet" detail="Each feature with a tool adds a tile here." />;
  return (
    <FlatList
      key={columns} // numColumns can't change on the fly
      data={tools}
      numColumns={columns}
      keyExtractor={keyOf}
      renderItem={({ item }) => <Tile tool={item} open={open} />}
      contentContainerStyle={styles.grid}
      columnWrapperStyle={styles.row}
    />
  );
}

const Tile = memo(function Tile({ tool, open }: { tool: Tool; open: (screen: string) => void }) {
  return (
    <Pressable style={styles.tile} onPress={() => open(tool.screen)} android_ripple={{ color: '#ffffff11' }} accessibilityRole="button" accessibilityLabel={tool.title}>
      <Icon name={tool.icon} size={32} color={colors.accent} />
      <Text style={styles.label} numberOfLines={2}>
        {tool.title}
      </Text>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  grid: { padding: space.m, gap: space.m },
  row: { gap: space.m },
  tile: { flex: 1, aspectRatio: 1, maxWidth: 160, backgroundColor: colors.surface, borderRadius: radius.l, alignItems: 'center', justifyContent: 'center', gap: space.s, padding: space.s, overflow: 'hidden' },
  label: { color: colors.text, fontSize: 14, textAlign: 'center' },
});
