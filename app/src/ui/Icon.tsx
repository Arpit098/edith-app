// Icons: MaterialCommunityIcons (Apache-2.0, bundled with @expo/vector-icons). Features name icons
// by string (Tool.icon, Screen.icon); an unknown name shows a puzzle piece instead of crashing.

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { memo } from 'react';

import { colors } from '../core/theme';

type Glyph = keyof typeof MaterialCommunityIcons.glyphMap;

export function isIcon(name: string): name is Glyph {
  return Object.prototype.hasOwnProperty.call(MaterialCommunityIcons.glyphMap, name);
}

export const Icon = memo(function Icon({ name, size = 22, color = colors.text }: { name: string; size?: number; color?: string }) {
  return <MaterialCommunityIcons name={isIcon(name) ? name : 'puzzle-outline'} size={size} color={color} />;
});
