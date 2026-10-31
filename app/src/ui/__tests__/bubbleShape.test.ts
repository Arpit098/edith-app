// The thinking bubble's geometry: the rim wobbles within its amplitude and loops seamlessly (t and
// t + 1 are the same frame); the glints sit inside the bubble where a soap bubble catches the light.

import { arcPath, bubbleHighlights, crescentPath, rimPath, rimRadius } from '../bubbleShape';

const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

/** The end points of a path made of M and A commands: [x, y] after M, and the last two numbers of each A. */
function points(d: string): [number, number][] {
  return d
    .split(/(?=[MA])/)
    .map(numbers)
    .map((n) => [n[n.length - 2]!, n[n.length - 1]!] as [number, number]);
}

describe('the thinking bubble', () => {
  it('wobbles its rim within ±amp of the radius', () => {
    for (let t = 0; t < 1; t += 0.05) {
      for (let a = 0; a < Math.PI * 2; a += 0.1) {
        const r = rimRadius(40, a, t, 0.05);
        expect(r).toBeGreaterThanOrEqual(40 * (1 - 0.05) - 1e-9);
        expect(r).toBeLessThanOrEqual(40 * (1 + 0.05) + 1e-9);
      }
    }
    expect(rimRadius(40, 1, 0.3, 0)).toBe(40); // no wobble: a circle
  });

  it('is a closed smooth path, the same at t and t + 1 (a seamless loop)', () => {
    const d = rimPath(50, 50, 40, 0.2, 0.05);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.split('C')).toHaveLength(17); // 16 Bézier segments
    expect(rimPath(50, 50, 40, 1.2, 0.05)).toBe(d);
    expect(rimPath(50, 50, 40, 0.7, 0.05)).not.toBe(d); // it moves
  });

  it('draws a crescent glint: on the circle at both ends, closed, with a flatter inner arc', () => {
    const d = crescentPath(50, 50, 30, Math.PI, 1.5 * Math.PI, 4);
    const [start, end, back] = points(d);
    expect(d.endsWith('Z')).toBe(true);
    for (const p of [start!, end!]) expect(Math.hypot(p[0] - 50, p[1] - 50)).toBeCloseTo(30, 1);
    expect(back).toEqual(start); // back where it began: a closed sliver
    const radii = d.split('A').slice(1).map((s) => numbers(s)[0]!);
    expect(radii[0]).toBeCloseTo(30, 1);
    expect(radii[1]).toBeGreaterThan(30); // the inner arc is flatter: the crescent tapers to points
  });

  it('puts the main glint at the top-left, the small one at the bottom-right, all inside the rim', () => {
    const R = 42;
    const { glint, spot, reflection } = bubbleHighlights(50, R);
    for (const [x, y] of points(glint)) {
      expect(x).toBeLessThan(50 + 1); // left of centre (the top end sits about straight up)
      expect(y).toBeLessThan(50 + 1); // above it
      expect(Math.hypot(x - 50, y - 50)).toBeLessThan(R * (1 - 0.05)); // inside the rim at its lowest wobble
    }
    expect(spot.cx).toBeGreaterThan(50);
    expect(spot.cy).toBeGreaterThan(50);
    expect(Math.hypot(spot.cx - 50, spot.cy - 50) + spot.r).toBeLessThan(R * 0.95);
    for (const [, y] of points(reflection)) expect(y).toBeGreaterThan(50); // along the bottom
    expect(arcPath(50, 50, 10, 0, Math.PI / 2)).toBe('M60.00 50.00A10.00 10.00 0 0 1 50.00 60.00');
  });
});
