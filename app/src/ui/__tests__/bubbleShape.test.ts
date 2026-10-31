// The thinking bubble's geometry: the rim wobbles within its amplitude and loops seamlessly (t and
// t + 1 are the same frame); the highlights are arcs where they should be, inside the rim.

import * as shape from '../bubbleShape';
import { arcPath, GLINTS, rimPath, rimRadius } from '../bubbleShape';

const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe('the thinking bubble', () => {
  it('wobbles its rim within ±amp of the radius', () => {
    for (let t = 0; t < 1; t += 0.05) {
      for (let a = 0; a < Math.PI * 2; a += 0.1) {
        const r = rimRadius(40, a, t, 0.055);
        expect(r).toBeGreaterThanOrEqual(40 * (1 - 0.055) - 1e-9);
        expect(r).toBeLessThanOrEqual(40 * (1 + 0.055) + 1e-9);
      }
    }
    expect(rimRadius(40, 1, 0.3, 0)).toBe(40); // no wobble: a circle
  });

  it('is a closed smooth path, the same at t and t + 1 (a seamless loop)', () => {
    const d = rimPath(50, 50, 40, 0.2, 0.055);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.split('C')).toHaveLength(17); // 16 Bézier segments
    expect(rimPath(50, 50, 40, 1.2, 0.055)).toBe(d);
    expect(rimPath(50, 50, 40, 0.7, 0.055)).not.toBe(d); // it moves
  });

  it('draws an arc from one angle to the other on its circle', () => {
    const [x0, y0, r, , , large, sweep, x1, y1] = numbers(arcPath(50, 50, 30, 0, Math.PI / 2));
    expect([x0, y0, r, large, sweep, x1, y1]).toEqual([80, 50, 30, 0, 1, 50, 80]); // clockwise on screen, the short way
    expect(numbers(arcPath(50, 50, 30, 0, 1.5 * Math.PI))[5]).toBe(1); // more than half: the large arc
  });

  it('puts the glint top-left, the tiny one bottom-right and the reflection below, all inside the rim', () => {
    const mid = (a: { from: number; to: number }) => (a.from + a.to) / 2;
    const side = (angle: number) => [Math.sign(Math.cos(angle)), Math.sign(Math.sin(angle))];
    expect(side(mid(GLINTS.main))).toEqual([-1, -1]); // top-left (y down)
    expect(side(GLINTS.tiny.at)).toEqual([1, 1]); // bottom-right
    expect(Math.sin(mid(GLINTS.reflection))).toBeGreaterThan(0); // the lower half
    const innermostRim = 0.93 * (1 - 0.05); // the soft inner rim at its smallest
    for (const r of [GLINTS.main.r, GLINTS.tiny.r + GLINTS.tiny.size, GLINTS.reflection.r]) expect(r).toBeLessThan(innermostRim - 0.05);
  });

  it('has no swirl bands any more', () => {
    expect(Object.keys(shape).sort()).toEqual(['GLINTS', 'arcPath', 'rimPath', 'rimRadius']);
  });
});
