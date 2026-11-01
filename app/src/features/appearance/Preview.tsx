// The live preview behind Appearance's tools: the app as it will look, filling the page. The
// background (photo, gradient, pattern) covers it all; the header, a short chat (two bubbles a side,
// one replying to a quote) and the composer sit in the top `scene` height, which stays in view above
// the half-open sheet. Drawn with the same pieces as the real screens (Ambient, Glass, the bubbles'
// glass face) in the preview's theme: the app's, with the draft over it (a slider being dragged, a
// gradient being built). It subscribes to the draft itself, so a drag repaints only the preview.
// The header and composer are real glass over the preview's own backdrop; the two newest bubbles are
// liquid glass over its own wallpaper, as the chat draws its newest ones (the rest are flat: the
// lenses are capped, and the chat behind Settings keeps its own).
//
// Nothing here is keyed on a value: the glass panes and the backdrop keep their native views while
// the theme changes, so a change is new props on the same views (no remount, no flash).

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { bubbleFace, colors, radius, space, ThemeContext, type, type BubbleLook, type Theme } from '../../core/theme';
import { Ambient } from '../../ui/Ambient';
import { BubbleFill } from '../../ui/BubbleFill';
import { BubbleLens, Glass, useBackdrop, useLiquid, WallpaperContext } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';
import { usePreviewTheme, type DraftStore } from './draft';

export const HEADER = 48;
export const COMPOSER = 52;

export const Preview = memo(function Preview({ draft, scene }: { draft: DraftStore; scene: number }) {
  const theme = usePreviewTheme(draft);
  return (
    <ThemeContext.Provider value={theme}>
      <Scene theme={theme} scene={scene} />
    </ThemeContext.Provider>
  );
});

function Scene({ theme: t, scene }: { theme: Theme; scene: number }) {
  const backdrop = useBackdrop();
  const wallpaper = useBackdrop(); // the preview's own wallpaper: its bubbles' lens looks through it, as in the chat
  return (
    <View style={StyleSheet.absoluteFill} accessible accessibilityLabel={`Preview: ${t.preset.name}, glass ${t.glass}%`} testID="appearance-preview">
      <View ref={backdrop.ref} collapsable={false} style={StyleSheet.absoluteFill}>
        <View ref={wallpaper.ref} collapsable={false} style={StyleSheet.absoluteFill} pointerEvents="none">
          <Ambient />
        </View>
        <WallpaperContext.Provider value={wallpaper.tag}>
          <View style={[styles.chat, { height: scene }]}>
            <Bubble look={t.edith} side="edith" testID="preview-edith" text="Morning! The build passed and PR 41 is ready." />
            <Bubble look={t.my} side="my" testID="preview-mine" text="Nice, ship it" time="09:41 ✓✓" />
            <Bubble look={t.edith} side="edith" glass testID="preview-edith-new" text="Shipped. Want the release notes?" />
            <Bubble look={t.my} side="my" glass testID="preview-mine-new" quote="Want the release notes?" text="Yes please" time="09:42 ✓✓" />
          </View>
        </WallpaperContext.Provider>
      </View>
      <Glass level="thick" backdrop={backdrop.tag} radius={0} edges={{ bottom: true }} style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={[styles.title, { textShadowColor: t.titleGlow }]}>E.D.I.T.H</Text>
          <Icon name="menu" size={20} color={colors.text} />
        </View>
      </Glass>
      <View style={[styles.composer, { top: scene - COMPOSER }]}>
        <Glass level="control" backdrop={backdrop.tag} radius={20} rim style={styles.round}>
          <Icon name="dots-grid" size={18} color={colors.text} />
        </Glass>
        <Glass level="control" backdrop={backdrop.tag} radius={20} rim style={styles.pill}>
          <Text style={styles.placeholder}>Message</Text>
          <Icon name="microphone-outline" size={18} color={colors.textDim} />
        </Glass>
        <Glass level="control" backdrop={backdrop.tag} radius={20} rim style={styles.round}>
          <Icon name="send" size={18} color={t.accent} />
        </Glass>
      </View>
    </View>
  );
}

/**
 * A bubble as the chat draws it. `glass`: one of the newest, liquid glass where the device has it
 * (its rim the edge); the others, and every bubble without the lens, show their flat tint.
 */
function Bubble({ look, side, text, time, quote, glass = false, testID }: { look: BubbleLook; side: 'my' | 'edith'; text: string; time?: string; quote?: string; glass?: boolean; testID?: string }) {
  const mine = side === 'my';
  const tail = mine ? 'right' : 'left';
  const lens = useLiquid(look); // a hook: asked for every bubble, used for the newest
  const liquid = glass && lens;
  return (
    <View style={[styles.bubble, mine ? styles.mine : styles.edith, bubbleFace(look), liquid && styles.noEdge]} testID={testID}>
      {liquid ? <BubbleLens look={look} tail={tail} /> : null}
      <BubbleFill look={look} tail={tail} cover={liquid} />
      {quote ? (
        <View style={[styles.quote, { backgroundColor: look.inkSoft, borderLeftColor: look.ink }]}>
          <Text style={[styles.quoteFrom, { color: look.ink }]}>EDITH</Text>
          <Text style={[styles.quoteText, { color: look.ink }]} numberOfLines={1}>
            {quote}
          </Text>
        </View>
      ) : null}
      <Text style={[styles.text, { color: look.ink }]}>{text}</Text>
      {time ? <Text style={[styles.time, { color: look.inkDim }]}>{time}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  noEdge: { borderTopColor: 'transparent', borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: 'transparent' },
  header: { position: 'absolute', top: 0, left: 0, right: 0, height: HEADER, justifyContent: 'center' },
  headerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: space.l },
  title: { flex: 1, color: colors.text, textAlign: 'center', fontSize: type.size.title, fontWeight: '700', letterSpacing: 1.2, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8 },
  chat: { justifyContent: 'flex-end', paddingHorizontal: space.m, paddingTop: HEADER + space.s, paddingBottom: COMPOSER + space.s, gap: space.xs },
  bubble: { maxWidth: '78%', borderRadius: radius.l, borderWidth: 1, paddingHorizontal: space.m, paddingVertical: space.s },
  edith: { alignSelf: 'flex-start', borderBottomLeftRadius: radius.s },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: radius.s },
  quote: { borderLeftWidth: 2, borderRadius: radius.s, paddingHorizontal: space.s, paddingVertical: 2, marginBottom: space.xs },
  quoteFrom: { fontSize: type.size.caption, fontWeight: '700' },
  quoteText: { fontSize: type.size.caption },
  text: { fontSize: type.size.body, lineHeight: 20 },
  time: { fontSize: type.size.caption, alignSelf: 'flex-end', marginTop: 2 },
  composer: { position: 'absolute', left: space.s, right: space.s, height: COMPOSER - space.s, flexDirection: 'row', alignItems: 'center', gap: space.s },
  round: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  pill: { flex: 1, height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.m },
  placeholder: { color: colors.textFaint, fontSize: type.size.body },
});
