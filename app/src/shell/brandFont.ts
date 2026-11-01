// The "E.D.I.T.H" heading's typeface: Michroma (Google Fonts, SIL OFL 1.1; the licence is
// assets/fonts/Michroma-OFL.txt). Arpit's pick, 1 Nov.
//
// It's a JS asset loaded at runtime by expo-font, not the expo-font config plugin, so it ships in
// an OTA update (`expo export` lists it in metadata.json; scripts/ota.js serves it) with no rebuild.
// Loading never holds the first frame: the system font shows until Michroma is ready, then swaps.
// If it fails to load, the heading just keeps the system font.

import { useFonts } from 'expo-font';

/** The family name the font is registered under. */
export const BRAND_FONT = 'Michroma';

const sources = { [BRAND_FONT]: require('../../assets/fonts/Michroma-Regular.ttf') as number };

/** True once Michroma is ready to draw (false while loading, and for good if loading failed). */
export function useBrandFont(): boolean {
  const [loaded] = useFonts(sources);
  return loaded;
}
