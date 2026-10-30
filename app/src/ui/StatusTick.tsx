// Message status ticks: outline strokes only (no fill, no colour, no emoji), in the muted text grey,
// sized to the time text beside them. Arpit's spec: a clock (not acknowledged yet), one check
// (the server has it), two overlapping checks (EDITH took it in), and ! in a circle (failed).

import { memo } from 'react';
import Svg, { Circle, Path } from 'react-native-svg';

export type TickKind = 'clock' | 'sent' | 'delivered' | 'failed';

const STROKE = { fill: 'none', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const StatusTick = memo(function StatusTick({ kind, color, size = 13 }: { kind: TickKind; color: string; size?: number }) {
  const width = kind === 'delivered' ? size * 1.3 : size; // the double check is a little wider
  return (
    <Svg width={width} height={size} viewBox={kind === 'delivered' ? '0 0 18 14' : '0 0 14 14'} accessible={false}>
      {kind === 'clock' ? (
        <>
          <Circle cx={7} cy={7} r={5.6} stroke={color} {...STROKE} />
          <Path d="M7 4.2V7l1.9 1.3" stroke={color} {...STROKE} />
        </>
      ) : kind === 'sent' ? (
        <Path d="M2.5 7.4l3 3 6-6.4" stroke={color} {...STROKE} />
      ) : kind === 'delivered' ? (
        <>
          <Path d="M1.5 7.4l3 3 6-6.4" stroke={color} {...STROKE} />
          <Path d="M7.8 10l.4.4 6-6.4" stroke={color} {...STROKE} />
        </>
      ) : (
        <>
          <Circle cx={7} cy={7} r={5.6} stroke={color} {...STROKE} />
          <Path d="M7 4.2v3.4M7 9.8v.01" stroke={color} {...STROKE} />
        </>
      )}
    </Svg>
  );
});
