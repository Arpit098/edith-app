// The thinking orb's motion: every moving part loops seamlessly (t and t + 1 are the same frame),
// actually moves within a cycle, and stays where the orb can show it.

import { BLOBS, blobAt, breath, glossOf, RIBBONS, ribbonPath } from '../orbShape';

const C = 50;
const R = 40;
const numbers = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);

describe('the thinking orb', () => {
  it('drifts its blobs in a seamless loop, centres inside the orb, each big enough to blend', () => {
    for (const b of BLOBS) {
      const start = blobAt(b, C, R, 0.2);
      const next = blobAt(b, C, R, 1.2);
      expect(next.cx).toBeCloseTo(start.cx, 6);
      expect(next.cy).toBeCloseTo(start.cy, 6);
      expect(next.r).toBeCloseTo(start.r, 6);
      expect(Math.hypot(blobAt(b, C, R, 0.6).cx - start.cx, blobAt(b, C, R, 0.6).cy - start.cy)).toBeGreaterThan(1); // it moves
      for (let t = 0; t < 1; t += 0.05) {
        const p = blobAt(b, C, R, t);
        expect(Math.hypot(p.cx - C, p.cy - C)).toBeLessThan(R); // its brightest part stays inside
        expect(p.r).toBeGreaterThan(R * 0.4); // soft colour, not a dot
      }
    }
  });

  it('swirls its ribbons as closed smooth paths, inside the orb, looping seamlessly', () => {
    for (const rb of RIBBONS) {
      const d = ribbonPath(rb, C, R, 0.3);
      expect(d.startsWith('M')).toBe(true);
      expect(d.endsWith('Z')).toBe(true);
      expect(d.split('C')).toHaveLength(21); // 20 points: 11 along the outer edge, 9 back along the inner
      expect(ribbonPath(rb, C, R, 1.3)).toBe(d);
      expect(ribbonPath(rb, C, R, 0.55)).not.toBe(d); // it moves
      const xy = numbers(d);
      for (let i = 0; i < xy.length; i += 2) expect(Math.hypot(xy[i]! - C, xy[i + 1]! - C)).toBeLessThan(R * 1.05);
    }
  });

  it('breathes its edge between 0 and 1, seamlessly', () => {
    for (let t = 0; t < 1; t += 0.05) {
      expect(breath(t)).toBeGreaterThanOrEqual(0);
      expect(breath(t)).toBeLessThanOrEqual(1);
    }
    expect(breath(1.3)).toBeCloseTo(breath(0.3), 9);
  });

  it('puts the glossy highlight at the top-left, inside the orb', () => {
    const g = glossOf(C, R);
    expect(g.cx).toBeLessThan(C);
    expect(g.cy).toBeLessThan(C);
    expect(Math.hypot(g.cx - C, g.cy - C) + g.ry).toBeLessThan(R);
  });
});
