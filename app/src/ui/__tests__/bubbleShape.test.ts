// The thinking bubble's geometry: the rim wobbles within its amplitude, every shape loops
// seamlessly (t and t + 1 are the same frame), and the swirl bands stay inside the orb.

import { bandPath, BANDS, rimPath, rimRadius } from '../bubbleShape';

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
    for (let i = 0; i < BANDS.length; i++) expect(bandPath(50, 50, 40, 1.35, i)).toBe(bandPath(50, 50, 40, 0.35, i));
  });

  it('keeps the swirl bands inside the orb', () => {
    for (let i = 0; i < BANDS.length; i++) {
      for (let t = 0; t < 1; t += 0.05) {
        const d = bandPath(50, 50, 40, t, i);
        // The endpoints of the two arcs are the ellipse's far ends: within the radius of the centre.
        const [mx, my] = numbers(d.slice(1));
        expect(Math.hypot(mx! - 50, my! - 50)).toBeLessThan(40);
      }
    }
  });
});
