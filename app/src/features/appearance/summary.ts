import { BACKGROUNDS, GRADIENT_BACKGROUNDS, PRESETS, type Appearance } from '../../core/theme';

/** A background's name: "Dots", "Sunset", "Custom 2". */
export function backgroundName(a: Appearance): string {
  const custom = a.customGradients.findIndex((c) => c.id === a.background);
  if (custom >= 0) return `Custom ${custom + 1}`;
  return BACKGROUNDS.find((b) => b.id === a.background)?.name ?? GRADIENT_BACKGROUNDS.find((b) => b.id === a.background)?.name ?? a.background;
}

/** The Settings row's line: "Ocean · Dots · Glass 60%" (the theme's own glow isn't named). */
export function appearanceSummary(a: Appearance): string {
  const theme = PRESETS.find((p) => p.id === a.theme)?.name ?? a.theme;
  const background = a.background === 'glow' ? null : backgroundName(a);
  return [theme, background, `Glass ${a.glass}%`].filter(Boolean).join(' · ');
}
