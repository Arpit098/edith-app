// Compatibility: the old theme module, for code written before Phase 2b moved the tokens to
// core/theme. The old names map to the new tokens, so such code gets the new look without edits.
// New code imports '../core/theme' directly.

import { colors as tokens, type } from '../core/theme';

export { radius, space } from '../core/theme';

export const colors = {
  ...tokens,
  surface: tokens.card,
  surfaceHigh: tokens.cardRaised,
  border: tokens.hairline,
  user: tokens.userBubble,
} as const;

export const mono = type.mono;
