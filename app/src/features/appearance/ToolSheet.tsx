// Appearance's bottom sheet and toolbar. The toolbar (icon + label tools, scrolling sideways when they
// don't fit) is always there; a tool's controls come up in the sheet, which has a fixed height and
// slides (it never resizes, so switching tools moves nothing): a spring on the UI thread (reanimated),
// at once with "Remove animations" (ui/SnapSheet). Its grab handle drags it between the two snap points; the
// chevron buttons collapse it to the toolbar and bring it back.

import { useEffect, useRef, type ReactNode } from 'react';
import { AccessibilityInfo, findNodeHandle, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space, type, useTheme } from '../../core/theme';
import { Glass } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { SnapSheet } from '../../ui/SnapSheet';
import { snapFor, TOOLS, toolOf, type SheetAction, type SheetState } from './sheet';

export const TOOLBAR = 72;
export const PEEK = 24; // the closed sheet's grab strip above the toolbar: drag it to open

const opens = (progress: number, velocity: number) => snapFor(progress, velocity) === 'half';

export function Sheet({ state, dispatch, height, children }: { state: SheetState; dispatch: (a: SheetAction) => void; height: number; children: ReactNode }) {
  const open = state.snap === 'half';
  const tool = state.tool ? toolOf(state.tool) : null;
  // TalkBack's focus goes to the sheet's title when it opens (or switches tool), so the controls
  // are where the reading continues.
  const title = useRef<Text>(null);
  useEffect(() => {
    if (!open) return;
    const node = title.current ? findNodeHandle(title.current) : null;
    if (node) AccessibilityInfo.setAccessibilityFocus(node);
  }, [open, state.tool]);
  return (
    <SnapSheet
      open={open}
      height={height}
      peek={PEEK}
      snap={opens}
      onSettle={(progress, velocity) => dispatch({ type: 'settle', progress, velocity })}
      style={[styles.sheet, { bottom: TOOLBAR }]}
      testID="appearance-sheet"
    >
      {(handle, shown) => (
        <Glass level="panel" radius={radius.l} rim style={styles.panel}>
          <View {...handle} style={styles.head} testID="sheet-handle">
            <View style={styles.grab} />
            <View style={styles.titleRow}>
              <View style={styles.flex}>
                <Text ref={title} style={styles.title} accessibilityRole="header">
                  {tool?.label ?? ''}
                </Text>
                {tool ? (
                  <Text style={styles.hint} numberOfLines={2}>
                    {tool.hint}
                  </Text>
                ) : null}
              </View>
              <Pressable onPress={() => dispatch({ type: 'collapse' })} hitSlop={8} style={styles.chevron} accessibilityRole="button" accessibilityLabel={`Close ${tool?.label ?? ''} controls`}>
                <Icon name="chevron-down" size={24} />
              </Pressable>
            </View>
          </View>
          {/* Closed, only the grab strip takes touches (to drag it open). */}
          <View style={styles.flex} pointerEvents={shown ? 'auto' : 'none'}>
            <ScrollView style={styles.flex} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" testID="sheet-body">
              {children}
            </ScrollView>
          </View>
        </Glass>
      )}
    </SnapSheet>
  );
}

export function Toolbar({ state, dispatch }: { state: SheetState; dispatch: (a: SheetAction) => void }) {
  const { accent, accentSoft } = useTheme();
  const open = state.snap === 'half';
  return (
    <Glass level="thick" radius={0} edges={{ top: true }} style={styles.toolbar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tools}>
        {TOOLS.map((t) => {
          const on = open && state.tool === t.id;
          return (
            <Pressable
              key={t.id}
              onPress={() => dispatch({ type: 'pick', tool: t.id })}
              style={[styles.tool, on && { backgroundColor: accentSoft }]}
              accessibilityRole="button"
              accessibilityState={{ expanded: on }}
              accessibilityLabel={t.label}
              accessibilityHint={t.hint}
              testID={`tool-${t.id}`}
            >
              <Icon name={t.icon} size={24} color={on ? accent : colors.text} />
              <Text style={[styles.toolLabel, on && { color: accent, fontWeight: '700' }]} numberOfLines={1}>
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        onPress={() => dispatch(open ? { type: 'collapse' } : { type: 'expand' })}
        hitSlop={8}
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityLabel={open ? 'Close the controls' : 'Show the controls'}
        accessibilityState={{ expanded: open }}
        testID="sheet-toggle"
      >
        <Icon name={open ? 'chevron-down' : 'chevron-up'} size={24} />
      </Pressable>
    </Glass>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheet: { position: 'absolute', left: space.s, right: space.s },
  panel: { flex: 1 },
  head: { paddingHorizontal: space.l, paddingTop: space.s, paddingBottom: space.s, gap: space.s },
  grab: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.textFaint },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  title: { color: colors.text, fontSize: type.size.title, fontWeight: '700' },
  hint: { color: colors.textSecondary, fontSize: type.size.small, marginTop: 2 },
  chevron: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  body: { paddingHorizontal: space.l, paddingBottom: space.l, gap: space.s },
  toolbar: { position: 'absolute', left: 0, right: 0, bottom: 0, height: TOOLBAR, flexDirection: 'row', alignItems: 'center' },
  tools: { paddingHorizontal: space.s, gap: space.xs, alignItems: 'center' },
  tool: { minWidth: 72, height: TOOLBAR - space.m, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: radius.m, paddingHorizontal: space.s },
  toolLabel: { color: colors.text, fontSize: type.size.caption },
  toggle: { width: 52, height: TOOLBAR, alignItems: 'center', justifyContent: 'center', borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: colors.hairline },
});
