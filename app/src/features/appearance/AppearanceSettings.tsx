// Settings → Appearance: a live preview on top, then five sections that open one at a time (so the
// page stays short): Theme, Background, Bubbles, Accent and Glass. Every tap applies at once (the app
// re-renders in the new theme). The preview also shows what isn't applied yet: the glass slider while
// it's dragged (applied on release, so a drag repaints only the preview), and a "Custom…" gradient
// while it's being built (kept only on Save).

import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ACCENTS, BUBBLE_GRADIENTS, CUSTOM_BUBBLE, PRESETS, resolveTheme, space, SWATCHES, useAppearance, useTheme, type Appearance } from '../../core/theme';
import { Section } from './parts';
import { Preview } from './Preview';
import { AccentSection, BackgroundSection, BubblesSection, GlassSection, ThemeSection } from './sections';
import { backgroundName } from './summary';

type SectionId = 'theme' | 'background' | 'bubbles' | 'accent' | 'glass';

export function AppearanceSettings() {
  const { appearance, set } = useAppearance();
  const live = useTheme(); // the app's theme (it knows "reduce transparency")
  const [open, setOpen] = useState<SectionId | null>('theme');
  const [dragging, setDragging] = useState<number | null>(null); // the glass amount while the slider moves
  const [draft, setDraft] = useState<Partial<Appearance> | null>(null); // a gradient being built
  const shown = dragging ?? appearance.glass;
  const preview = useMemo(() => {
    if (dragging === null && draft === null) return live;
    const reduced = live.glass === 0 && appearance.glass > 0;
    return resolveTheme({ ...appearance, ...draft, ...(dragging === null ? {} : { glass: dragging }) }, reduced);
  }, [dragging, draft, live, appearance]);

  const toggle = (id: SectionId) => {
    setDraft(null); // closing a section drops a gradient left half-built in it
    setOpen((o) => (o === id ? null : id));
  };
  const props = { appearance, set };
  return (
    <View style={styles.page}>
      <Preview theme={preview} />
      <Section title="Theme" value={PRESETS.find((p) => p.id === appearance.theme)?.name ?? ''} open={open === 'theme'} onToggle={() => toggle('theme')}>
        <ThemeSection {...props} />
      </Section>
      <Section title="Background" value={backgroundName(appearance)} open={open === 'background'} onToggle={() => toggle('background')}>
        <BackgroundSection {...props} onDraft={setDraft} />
      </Section>
      <Section title="Bubbles" value={`${bubbleName(appearance.myBubble)} · ${bubbleName(appearance.edithBubble)}`} open={open === 'bubbles'} onToggle={() => toggle('bubbles')}>
        <BubblesSection {...props} onDraft={setDraft} />
      </Section>
      <Section title="Accent" value={ACCENTS.find((a) => a.id === appearance.accent)?.name ?? 'Theme’s'} open={open === 'accent'} onToggle={() => toggle('accent')}>
        <AccentSection {...props} />
      </Section>
      <Section title="Glass" value={`${appearance.glass}%`} open={open === 'glass'} onToggle={() => toggle('glass')}>
        <GlassSection {...props} shown={shown} onDrag={setDragging} />
      </Section>
    </View>
  );
}

function bubbleName(id: string | null): string {
  if (id === null) return 'Default';
  if (id === CUSTOM_BUBBLE) return 'Custom';
  return SWATCHES.find((s) => s.id === id)?.name ?? BUBBLE_GRADIENTS.find((b) => b.id === id)?.name ?? 'Default';
}

const styles = StyleSheet.create({
  page: { gap: space.s },
});
