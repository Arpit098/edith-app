import { BACKGROUNDS, PRESETS, type Appearance } from '../../core/theme';

/** The Settings row's line: "Ocean · Dots · Glass 60%". */
export function appearanceSummary(a: Appearance): string {
  const theme = PRESETS.find((p) => p.id === a.theme)?.name ?? a.theme;
  const background = a.background === 'glow' ? null : BACKGROUNDS.find((b) => b.id === a.background)?.name;
  return [theme, background, `Glass ${a.glass}%`].filter(Boolean).join(' · ');
}
