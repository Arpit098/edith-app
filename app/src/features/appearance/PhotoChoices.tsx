// Background → "Your photos": up to MAX_PHOTOS of Arpit's own pictures as tiles, "Your photo…" to
// pick one from the gallery, and, while one is the background, how it's shown: which part stays in
// view, blur, dim and the theme's tint. A slider's drag shows in the page's preview only (onDraft);
// it's applied on release, so the app's backdrop (and every glass pane over it) redraws once.
//
// Readability isn't left to the dim chosen: the theme dims a bright photo further where text would
// fall under 4.5:1 (core/theme/themes.ts), and the hint says so.

import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  colors,
  cutAxis,
  DEFAULT_PHOTO_ADJUST,
  isPhotoBackground,
  MAX_PHOTOS,
  PHOTO_BLUR_MAX,
  PHOTO_DIM_MAX,
  PHOTO_FOCI,
  photoLook,
  radius,
  space,
  type as typography,
  useTheme,
  type Appearance,
  type PhotoActions,
  type PhotoBackground,
  type PhotoFocus,
  type Theme,
} from '../../core/theme';
import { Ambient } from '../../ui/Ambient';
import { Icon } from '../../ui/Icon';
import { Slider } from '../../ui/Slider';
import { Heading, Hint, Labelled, LinkButton, Segment, shared, TILE, Tile } from './parts';

const FOCUS_NAMES: Record<'horizontal' | 'vertical', Record<PhotoFocus, string>> = {
  vertical: { start: 'Top', center: 'Centre', end: 'Bottom' },
  horizontal: { start: 'Left', center: 'Centre', end: 'Right' },
};

export interface PhotoChoicesProps {
  appearance: Appearance;
  set: (change: Partial<Appearance>) => void;
  photos: PhotoActions | undefined;
  preview: Theme; // the page's preview theme: it knows how much the photo is really dimmed
  onDraft: (d: Partial<Appearance> | null) => void;
}

export function PhotoChoices({ appearance, set, photos: actions, preview, onDraft }: PhotoChoicesProps) {
  const { preset } = useTheme();
  const screen = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const chosen = isPhotoBackground(appearance.background) ? appearance.background : null;
  const adjust = chosen ?? { kind: 'photo' as const, uri: '', ...DEFAULT_PHOTO_ADJUST };
  // Each kept photo drawn as it would be with the current blur, dim and tint (still, decoded small).
  const tiles = useMemo(
    () => appearance.photos.map((p, i) => ({ photo: p, name: `Photo ${i + 1}`, look: photoLook(preset, p, { ...(chosen ?? { kind: 'photo' as const, ...DEFAULT_PHOTO_ADJUST }), uri: p.uri }) })),
    [appearance.photos, preset, chosen],
  );
  const current = chosen ? appearance.photos.find((p) => p.uri === chosen.uri) : undefined;

  const add = async () => {
    if (!actions || busy) return;
    setBusy(true);
    try {
      await actions.add();
    } catch (e) {
      console.warn('[edith] wallpaper not added', e);
      Alert.alert('Couldn’t use that photo', 'It couldn’t be read or saved. Try another one.');
    } finally {
      setBusy(false);
    }
  };
  const remove = (uri: string, name: string) => {
    Alert.alert(`Remove ${name}?`, 'It goes from your photos (the picture in your gallery stays).', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => actions?.remove(uri) },
    ]);
  };
  // A change: shown in the preview while a slider moves, applied when it's let go.
  const change = (c: Partial<PhotoBackground>, done: boolean) => {
    if (!chosen) return;
    const background = { ...chosen, ...c };
    if (done) {
      set({ background });
      onDraft(null);
    } else onDraft({ background });
  };

  const shown = preview.background.photo;
  const draftBg = isPhotoBackground(preview.appearance.background) ? preview.appearance.background : chosen;
  const axis = current ? cutAxis(screen.width, screen.height, current.width, current.height) : 'vertical';
  return (
    <>
      <Heading>{`Your photos (${appearance.photos.length} of ${MAX_PHOTOS})`}</Heading>
      <View style={shared.tiles} accessibilityRole="radiogroup">
        {tiles.map((t) => (
          <Tile
            key={t.photo.uri}
            name={t.name}
            label={`${t.name} background`}
            on={chosen?.uri === t.photo.uri}
            onPress={() => set({ background: { ...adjust, kind: 'photo', uri: t.photo.uri } })}
            art={<Ambient look={t.look} />}
          />
        ))}
        {actions ? (
          <Pressable onPress={add} disabled={busy} style={styles.addTile} accessibilityRole="button" accessibilityLabel="Your photo: pick one from the gallery" accessibilityState={{ disabled: busy, busy }}>
            <View style={styles.addArt}>
              <Icon name={busy ? 'progress-clock' : 'image-plus'} size={22} color={colors.textDim} />
            </View>
            <Text style={styles.addName} numberOfLines={1}>
              {busy ? 'Adding…' : 'Your photo…'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {!actions ? <Hint>Photos can be picked in the app on the phone.</Hint> : null}
      {appearance.photos.length >= MAX_PHOTOS && actions ? <Hint>{`The ${MAX_PHOTOS} most recent are kept: a new one replaces the oldest.`}</Hint> : null}

      {chosen && current && draftBg ? (
        <View style={styles.box} testID="photo-adjust">
          <Heading>{axis === 'vertical' ? 'Keep in view' : 'Keep in view (sides)'}</Heading>
          <View style={shared.segments} accessibilityRole="radiogroup">
            {PHOTO_FOCI.map((f) => (
              <Segment key={f} label={FOCUS_NAMES[axis][f]} a11y={`Keep the ${FOCUS_NAMES[axis][f].toLowerCase()} in view`} on={chosen.focus === f} onPress={() => change({ focus: f }, true)} />
            ))}
          </View>
          <Labelled icon="blur" value={`${draftBg.blur}`}>
            <Slider
              value={chosen.blur / PHOTO_BLUR_MAX}
              step={1 / PHOTO_BLUR_MAX}
              label="Blur"
              valueText={(v) => `${Math.round(v * PHOTO_BLUR_MAX)} of ${PHOTO_BLUR_MAX}`}
              onMove={(v) => change({ blur: Math.round(v * PHOTO_BLUR_MAX) }, false)}
              onChange={(v) => change({ blur: Math.round(v * PHOTO_BLUR_MAX) }, true)}
            />
          </Labelled>
          <Labelled icon="brightness-4" value={`${draftBg.dim}%`}>
            <Slider
              value={chosen.dim / PHOTO_DIM_MAX}
              step={5 / PHOTO_DIM_MAX}
              label="Dim"
              valueText={(v) => `${Math.round(v * PHOTO_DIM_MAX)} percent`}
              onMove={(v) => change({ dim: Math.round(v * PHOTO_DIM_MAX) }, false)}
              onChange={(v) => change({ dim: Math.round(v * PHOTO_DIM_MAX) }, true)}
            />
          </Labelled>
          {shown?.raised ? <Hint>{`Dimmed to ${shown.dim}% on screen, so text stays easy to read on this photo.`}</Hint> : null}
          <View style={shared.segments} accessibilityRole="radiogroup">
            <Segment label="No tint" on={!chosen.tint} onPress={() => change({ tint: false }, true)} />
            <Segment label="Theme tint" a11y={`Tint the photo in the theme’s colour`} on={chosen.tint} onPress={() => change({ tint: true }, true)} />
          </View>
          <View style={shared.links}>
            <LinkButton label="Remove this photo" onPress={() => remove(chosen.uri, tiles.find((t) => t.photo.uri === chosen.uri)?.name ?? 'this photo')} />
          </View>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  addTile: { width: TILE, alignItems: 'center', gap: space.xs },
  addArt: { width: TILE, height: TILE, borderRadius: radius.m, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: colors.hairline },
  addName: { color: colors.textDim, fontSize: typography.size.caption },
  box: { gap: space.s, padding: space.m, borderRadius: radius.m, backgroundColor: colors.cardRaised },
});
