// Appearance: Telegram-like themes, each side's bubble colour, the background, and how much glass
// (Settings → App → Appearance). The choices live in the app's appearance store (core/appearance,
// provided by the composition root through AppearanceContext) and apply at once, everywhere.

import type { FeatureModule } from '../../core/feature';
import { useAppearance } from '../../core/theme';
import { AppearanceSettings } from './AppearanceSettings';
import { appearanceSummary } from './summary';

function useSummary() {
  return appearanceSummary(useAppearance().appearance);
}

const appearance: FeatureModule = {
  id: 'appearance',
  settings: [{ title: 'Appearance', component: AppearanceSettings, group: 'app', icon: 'palette-outline', order: 5, summary: useSummary }],
};

export default appearance;
