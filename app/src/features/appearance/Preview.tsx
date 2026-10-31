// The live preview at the top of Appearance: a small chat with the header, one bubble from each
// side and the composer, drawn with the same pieces as the real screens (Ambient, Glass, the
// bubbles' glass face) in the theme it is given, so it follows every choice, the glass
// slider while it's being dragged included. The header and composer are real glass over the
// preview's own backdrop.

import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { bubbleFace, colors, radius, space, ThemeContext, type, type Theme } from '../../core/theme';
import { Ambient } from '../../ui/Ambient';
import { Glass, useBackdrop } from '../../ui/Glass';
import { Icon } from '../../ui/Icon';

export const PREVIEW_HEIGHT = 260;

export const Preview = memo(function Preview({ theme }: { theme: Theme }) {
  return (
    <ThemeContext.Provider value={theme}>
      <Scene theme={theme} />
    </ThemeContext.Provider>
  );
});

function Scene({ theme: t }: { theme: Theme }) {
  const backdrop = useBackdrop();
  return (
    <View style={styles.frame} accessible accessibilityLabel={`Preview: ${t.preset.name}, glass ${t.glass}%`} testID="appearance-preview">
      <View ref={backdrop.ref} collapsable={false} style={StyleSheet.absoluteFill}>
        <Ambient />
        <View style={styles.chat}>
          <View style={[styles.bubble, styles.edith, bubbleFace(t.edith)]} testID="preview-edith">
            <Text style={[styles.text, { color: t.edith.ink }]}>Morning! The build passed and PR 41 is ready.</Text>
          </View>
          <View style={[styles.bubble, styles.mine, bubbleFace(t.my)]} testID="preview-mine">
            <Text style={[styles.text, { color: t.my.ink }]}>Nice, ship it</Text>
            <Text style={[styles.time, { color: t.my.inkDim }]}>09:41 ✓✓</Text>
          </View>
        </View>
      </View>
      <Glass level="thick" backdrop={backdrop.tag} radius={0} edges={{ bottom: true }} style={styles.header}>
        <Text style={[styles.title, { textShadowColor: t.titleGlow }]}>E.D.I.T.H</Text>
      </Glass>
      <View style={styles.composer}>
        <Glass level="control" backdrop={backdrop.tag} radius={20} rim style={styles.pill}>
          <Text style={styles.placeholder}>Message</Text>
        </Glass>
        <Glass level="control" backdrop={backdrop.tag} radius={20} rim style={styles.send}>
          <Icon name="send" size={18} color={colors.text} />
        </Glass>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: PREVIEW_HEIGHT, borderRadius: radius.l, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.hairline },
  header: { position: 'absolute', top: 0, left: 0, right: 0, height: 44, justifyContent: 'center' },
  title: { color: colors.text, textAlign: 'center', fontSize: type.size.title, fontWeight: '700', letterSpacing: 1.2, textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8 },
  chat: { flex: 1, justifyContent: 'center', paddingHorizontal: space.m, paddingTop: 44, paddingBottom: 56, gap: space.s },
  bubble: { maxWidth: '78%', borderRadius: radius.l, borderWidth: 1, paddingHorizontal: space.m, paddingVertical: space.s },
  edith: { alignSelf: 'flex-start', borderBottomLeftRadius: radius.s },
  mine: { alignSelf: 'flex-end', borderBottomRightRadius: radius.s },
  text: { fontSize: type.size.body, lineHeight: 20 },
  time: { fontSize: type.size.caption, alignSelf: 'flex-end', marginTop: 2 },
  composer: { position: 'absolute', left: space.s, right: space.s, bottom: space.s, flexDirection: 'row', gap: space.s },
  pill: { flex: 1, height: 40, justifyContent: 'center', paddingHorizontal: space.m },
  placeholder: { color: colors.textFaint, fontSize: type.size.body },
  send: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
