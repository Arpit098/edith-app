// Template feature: copy this folder to start a new one (see docs/ADDING_A_FEATURE.md),
// then add it to src/features/index.ts.

import type { FeatureModule } from '../../core/feature';

const template: FeatureModule = {
  id: '_template',
  screens: [],
  setup: ({ bus }) =>
    bus.subscribe('turn.done', (ev) => console.log('[template] turn done', ev.data), '_template'),
};

export default template;
