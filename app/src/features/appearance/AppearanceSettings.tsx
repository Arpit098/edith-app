// Settings → Appearance, an editor: the app as it will look fills the page (Preview), the tools sit
// in a toolbar at the bottom (Theme, Background, Photo, Bubbles, Accent, Glass, Reset: most used
// first), and a tool's controls come up in a sheet over the lower half, the preview's chat still in
// view above it. Every tap applies at once, as before; each tool can go back to the theme's default
// and Reset puts everything back (after asking). No Save or Cancel.
//
// What isn't applied yet (a slider being dragged, a gradient being built) is a draft (draft.ts) that
// only the preview and the open tool see: the store, and the whole app behind, change once on release
// or Save, so a drag never repaints anything else. Android back closes the sheet first, then leaves.

import { useEffect, useReducer, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Dimensions, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';

import { useStore } from '../../core/store';
import { colors, DEFAULT_APPEARANCE, DEFAULT_BACKGROUND, DEFAULT_GLASS, isPhotoBackground, radius, space, type, useAppearance, type Appearance } from '../../core/theme';
import { Button } from '../../ui/Button';
import { usePageBack } from '../../ui/pageBack';
import { createDraft, usePreviewTheme, type DraftStore } from './draft';
import { Hint, Segment, shared } from './parts';
import { PhotoChoices } from './PhotoChoices';
import { Preview } from './Preview';
import { AccentSection, BackgroundSection, BubblesSection, GlassSection, ThemeSection } from './sections';
import { backHandled, initialSheet, sheetAnnouncement, sheetReducer, type ToolId } from './sheet';
import { Sheet, TOOLBAR, Toolbar } from './ToolSheet';

/** The sheet covers this much of the page above the toolbar; the preview's chat fills the rest. */
const SHEET_SHARE = 0.5;

export function AppearanceSettings() {
  const [draft] = useState(createDraft);
  const [sheet, dispatch] = useReducer(sheetReducer, initialSheet);
  // The page's height: until it's measured, the window's (a fixed sheet height per layout: no jumps).
  const [height, setHeight] = useState(() => Dimensions.get('window').height * 0.8);
  const onLayout = (e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (h > 0) setHeight((old) => (old === h ? old : h));
  };
  const above = Math.max(0, height - TOOLBAR);
  const sheetHeight = Math.round(above * SHEET_SHARE);
  const scene = above - sheetHeight; // the preview's header, chat and composer: in view with the sheet up

  usePageBack(() => {
    if (!backHandled(sheet)) return false; // leaves the page
    dispatch({ type: 'back' });
    return true;
  });
  // A draft belongs to the tool that made it: switching tools drops it (a gradient half-built).
  useEffect(() => draft.put(null), [sheet.tool, draft]);
  // TalkBack hears the sheet open, switch and close (not the first render).
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current) AccessibilityInfo.announceForAccessibility(sheetAnnouncement(sheet));
    announced.current = true;
  }, [sheet]);

  return (
    <View style={styles.page} onLayout={onLayout} testID="appearance-editor">
      <Preview draft={draft} scene={Math.max(scene, 200)} />
      <Sheet state={sheet} dispatch={dispatch} height={sheetHeight}>
        {sheet.tool ? <ToolBody tool={sheet.tool} draft={draft} /> : null}
      </Sheet>
      <Toolbar state={sheet} dispatch={dispatch} />
    </View>
  );
}

// ---- each tool's controls ----

/** The theme's defaults for each tool (Reset puts these back). Your photos and gradients are kept. */
const DEFAULTS: Record<Exclude<ToolId, 'reset'>, Partial<Appearance>> = {
  theme: { theme: DEFAULT_APPEARANCE.theme },
  background: { background: DEFAULT_BACKGROUND },
  photo: { background: DEFAULT_BACKGROUND },
  bubbles: { myBubble: null, edithBubble: null },
  accent: { accent: null },
  glass: { glass: DEFAULT_GLASS },
};

export const RESET_ALL: Partial<Appearance> = Object.assign({}, ...Object.values(DEFAULTS));

/** Whether a tool already shows the theme's default (its Reset has nothing to do). */
export function isDefault(tool: Exclude<ToolId, 'reset'>, a: Appearance): boolean {
  if (tool === 'photo') return !isPhotoBackground(a.background);
  if (tool === 'background') return a.background === DEFAULT_BACKGROUND;
  return Object.entries(DEFAULTS[tool]).every(([k, v]) => a[k as keyof Appearance] === v);
}

function ToolBody({ tool, draft }: { tool: ToolId; draft: DraftStore }) {
  const { appearance, set } = useAppearance();
  const props = { appearance, set };
  const body = (() => {
    switch (tool) {
      case 'theme':
        return <ThemeSection {...props} />;
      case 'background':
        return <BackgroundSection {...props} onDraft={draft.put} />;
      case 'photo':
        return <PhotoTool draft={draft} />;
      case 'bubbles':
        return <BubblesTool draft={draft} />;
      case 'accent':
        return <AccentSection {...props} />;
      case 'glass':
        return <GlassTool draft={draft} />;
      case 'reset':
        return <ResetAll />;
    }
  })();
  return (
    <>
      {body}
      {tool !== 'reset' ? (
        <View style={styles.reset}>
          <Button
            small
            variant="ghost"
            icon="restore"
            label="Reset to theme default"
            disabled={isDefault(tool, appearance)}
            onPress={() => set(DEFAULTS[tool])}
            accessibilityLabel={`Reset ${tool} to the theme default`}
          />
        </View>
      ) : null}
    </>
  );
}

function PhotoTool({ draft }: { draft: DraftStore }) {
  const { appearance, set, photos } = useAppearance();
  const preview = usePreviewTheme(draft); // knows the dim really shown while a slider moves
  return <PhotoChoices appearance={appearance} set={set} photos={photos} preview={preview} onDraft={draft.put} />;
}

function BubblesTool({ draft }: { draft: DraftStore }) {
  const { appearance, set } = useAppearance();
  const [side, setSide] = useState<'my' | 'edith'>('my');
  return (
    <>
      <View style={shared.segments} accessibilityRole="radiogroup">
        <Segment label="My messages" on={side === 'my'} onPress={() => setSide('my')} />
        <Segment label="EDITH’s" a11y="EDITH’s messages" on={side === 'edith'} onPress={() => setSide('edith')} />
      </View>
      <BubblesSection key={side} appearance={appearance} set={set} onDraft={draft.put} only={side} />
    </>
  );
}

const selectGlass = (d: Partial<Appearance> | null) => d?.glass ?? null;

function GlassTool({ draft }: { draft: DraftStore }) {
  const { appearance, set } = useAppearance();
  const dragging = useStore(draft.store, selectGlass); // only this and the preview follow the drag
  return <GlassSection appearance={appearance} set={set} shown={dragging ?? appearance.glass} onDrag={(v) => draft.put(v === null ? null : { glass: v })} />;
}

function ResetAll() {
  const { appearance, set } = useAppearance();
  const tools = (Object.keys(DEFAULTS) as Exclude<ToolId, 'reset'>[]).filter((t) => !isDefault(t, appearance));
  const confirm = () =>
    Alert.alert('Reset the whole look?', 'Theme, background, bubbles, accent and glass go back to the defaults. Your photos and gradients stay, to pick again.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reset all', style: 'destructive', onPress: () => set(RESET_ALL) },
    ]);
  return (
    <View style={styles.resetAll}>
      <Text style={styles.text}>{tools.length ? `Changed from the default: ${tools.join(', ')}.` : 'Everything is at its default.'}</Text>
      <Hint>Your photos and your own gradients aren’t deleted.</Hint>
      <Button label="Reset all" icon="restore" variant="danger" disabled={!tools.length} onPress={confirm} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, overflow: 'hidden', borderTopLeftRadius: radius.l, borderTopRightRadius: radius.l },
  reset: { marginTop: space.m, alignItems: 'flex-start' },
  resetAll: { gap: space.m, alignItems: 'flex-start' },
  text: { color: colors.text, fontSize: type.size.body },
});
