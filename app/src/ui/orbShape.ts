// The thinking orb's motion (ui/ThinkingBubble draws it). Everything inside the orb is a function of
// one phase `t`, 0..1, computed in worklets on the UI thread once per frame while it moves. Every
// term turns a whole number of times per cycle (integer multiples of 2π·t), so a repeating 0 → 1
// loops with no jump, and t and t + 1 are the same frame.
//
// Angles are in SVG's frame (y down): 0 is right, π/2 the bottom, π the left, 3π/2 the top.

const TAU = Math.PI * 2;
const RIBBON_POINTS = 10; // along each edge of a ribbon

const f = (n: number) => {
  'worklet';
  return n.toFixed(2);
};

/** A soft colour blob drifting round the middle; sizes are shares of the orb's radius. */
export interface BlobSpec {
  orbit: number; // how far its centre sits from the orb's centre
  size: number; // its radius
  phase: number; // where it starts, in radians
  spin: number; // whole turns per cycle (negative: the other way)
}

/** A ribbon of light sweeping round inside the orb, like a band seen through glass. */
export interface RibbonSpec {
  radius: number; // the middle of its sweep
  span: number; // how much of a turn it covers, in radians (less than a full turn)
  width: number; // its thickest, in the middle
  squash: number; // flattens its sweep into an ellipse, so it reads as a tilted ring (1: a circle)
  phase: number;
  spin: number; // whole turns per cycle
}

/** A blob's circle at phase t: it orbits, and its orbit and size swell and ease. */
export function blobAt(b: BlobSpec, c: number, R: number, t: number): { cx: number; cy: number; r: number } {
  'worklet';
  const a = b.phase + TAU * b.spin * t;
  const d = R * b.orbit * (1 + 0.3 * Math.sin(TAU * 2 * t + b.phase));
  return {
    cx: c + d * Math.cos(a),
    cy: c + d * Math.sin(a),
    r: R * b.size * (1 + 0.12 * Math.sin(TAU * t + 2 * b.phase)),
  };
}

/** A closed smooth curve through the points (Catmull-Rom as cubic Béziers). */
function closedCurve(xs: number[], ys: number[]): string {
  'worklet';
  const n = xs.length;
  let d = `M${f(xs[0]!)} ${f(ys[0]!)}`;
  for (let i = 0; i < n; i++) {
    const p0 = (i + n - 1) % n;
    const p2 = (i + 1) % n;
    const p3 = (i + 2) % n;
    const c1x = xs[i]! + (xs[p2]! - xs[p0]!) / 6;
    const c1y = ys[i]! + (ys[p2]! - ys[p0]!) / 6;
    const c2x = xs[p2]! - (xs[p3]! - xs[i]!) / 6;
    const c2y = ys[p2]! - (ys[p3]! - ys[i]!) / 6;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(xs[p2]!)} ${f(ys[p2]!)}`;
  }
  return `${d}Z`;
}

/**
 * A ribbon at phase t: a band along a tilted elliptical sweep that spirals slightly inwards, tapering
 * to points at both ends. The sweep turns, and its tilt and radius breathe, so the bands cross and
 * fold into each other. One closed path: the outer edge forwards, the inner edge back.
 */
export function ribbonPath(rb: RibbonSpec, c: number, R: number, t: number): string {
  'worklet';
  const turn = rb.phase + TAU * rb.spin * t; // the whole sweep's rotation
  const squash = rb.squash * (1 + 0.18 * Math.sin(TAU * t + rb.phase)); // the tilt rocks
  const cosT = Math.cos(turn);
  const sinT = Math.sin(turn);
  const xs: number[] = [];
  const ys: number[] = [];
  const edge = (side: number, u: number) => {
    const a = rb.span * (u - 0.5); // along the sweep, centred on 0
    const rc = R * rb.radius * (1 + 0.22 * (u - 0.5) + 0.06 * Math.sin(TAU * t + 3 * a)); // spirals in a little
    const half = (R * rb.width * Math.sin(Math.PI * u)) / 2; // tapers to points at both ends
    const rr = rc + side * half;
    const x = rr * Math.cos(a);
    const y = rr * Math.sin(a) * squash;
    xs.push(c + x * cosT - y * sinT);
    ys.push(c + x * sinT + y * cosT);
  };
  for (let i = 0; i <= RIBBON_POINTS; i++) edge(1, i / RIBBON_POINTS);
  for (let i = RIBBON_POINTS - 1; i > 0; i--) edge(-1, i / RIBBON_POINTS);
  return closedCurve(xs, ys);
}

/** The edge's breath at phase t, 0..1: twice per cycle, so it's gentle next to the swirl. */
export function breath(t: number): number {
  'worklet';
  return 0.5 + 0.5 * Math.sin(TAU * 2 * t);
}

/**
 * What's inside the orb, back to front: four soft colour blobs (deep violet, the logo's blue,
 * lavender, icy cyan) and three ribbons of light. Indexes match the colours in ThinkingBubble.
 */
export const BLOBS: readonly BlobSpec[] = [
  { orbit: 0.5, size: 0.85, phase: 0.6, spin: 1 }, // deep violet: the shadowed side
  { orbit: 0.46, size: 0.85, phase: 2.7, spin: -1 }, // the logo's blue
  { orbit: 0.5, size: 0.72, phase: 4.4, spin: 1 }, // lavender
  { orbit: 0.42, size: 0.66, phase: 1.5, spin: 2 }, // icy cyan
];

export const RIBBONS: readonly RibbonSpec[] = [
  { radius: 0.56, span: 4.0, width: 0.34, squash: 0.62, phase: 0.4, spin: 1 }, // icy white
  { radius: 0.5, span: 3.6, width: 0.3, squash: 0.5, phase: 2.6, spin: -1 }, // cyan
  { radius: 0.68, span: 3.4, width: 0.26, squash: 0.78, phase: 4.6, spin: 1 }, // lavender
];

/** The glossy highlight at the top-left (still): an ellipse tilted along the sphere's curve. */
export function glossOf(c: number, R: number) {
  return { cx: c - R * 0.34, cy: c - R * 0.42, rx: R * 0.44, ry: R * 0.26, rotate: -32 };
}
