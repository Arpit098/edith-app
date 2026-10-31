// The thinking bubble's geometry (ui/ThinkingBubble draws it): the rim's SVG path, computed in a
// worklet on the UI thread once per frame while it animates, and the static highlights. `t` is the
// cycle's phase, 0..1; the rim is periodic in it (whole multiples of 2π), so a repeating 0 → 1 loops
// with no jump.

const TAU = Math.PI * 2;
const RIM_POINTS = 16;

const f = (n: number) => {
  'worklet';
  return n.toFixed(2);
};

/** The rim's radius at angle `a`: two slow waves running opposite ways, like a soap bubble's skin. */
export function rimRadius(r: number, a: number, t: number, amp: number): number {
  'worklet';
  return r * (1 + amp * (0.6 * Math.sin(3 * a + TAU * t) + 0.4 * Math.sin(5 * a - 2 * TAU * t + 1)));
}

/**
 * The wobbling rim: a smooth closed curve through RIM_POINTS points (Catmull-Rom as cubic Béziers),
 * centred on (cx, cy), its radius within r·(1 ± amp).
 */
export function rimPath(cx: number, cy: number, r: number, t: number, amp: number): string {
  'worklet';
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < RIM_POINTS; i++) {
    const a = (i / RIM_POINTS) * TAU;
    const rr = rimRadius(r, a, t, amp);
    xs.push(cx + rr * Math.cos(a));
    ys.push(cy + rr * Math.sin(a));
  }
  let d = `M${f(xs[0]!)} ${f(ys[0]!)}`;
  for (let i = 0; i < RIM_POINTS; i++) {
    const p0 = (i + RIM_POINTS - 1) % RIM_POINTS;
    const p2 = (i + 1) % RIM_POINTS;
    const p3 = (i + 2) % RIM_POINTS;
    const c1x = xs[i]! + (xs[p2]! - xs[p0]!) / 6;
    const c1y = ys[i]! + (ys[p2]! - ys[p0]!) / 6;
    const c2x = xs[p2]! - (xs[p3]! - xs[i]!) / 6;
    const c2y = ys[p2]! - (ys[p3]! - ys[i]!) / 6;
    d += `C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(xs[p2]!)} ${f(ys[p2]!)}`;
  }
  return `${d}Z`;
}

/**
 * A circular arc from angle `from` to `to` (radians, y down, so increasing angles turn clockwise on
 * screen) of radius r about (cx, cy): the bubble's glints and reflection. Static, drawn once.
 */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const large = to - from > Math.PI ? 1 : 0;
  const x0 = cx + r * Math.cos(from);
  const y0 = cy + r * Math.sin(from);
  const x1 = cx + r * Math.cos(to);
  const y1 = cy + r * Math.sin(to);
  return `M${f(x0)} ${f(y0)}A${f(r)} ${f(r)} 0 ${large} 1 ${f(x1)} ${f(y1)}`;
}

const DEG = Math.PI / 180;

/**
 * Where the highlights sit, as shares of the radius and angles in degrees (y down: 225° is the
 * top-left). All well inside the rim's smallest radius, so the wobble never crosses them.
 */
export const GLINTS = {
  main: { r: 0.74, from: 196 * DEG, to: 252 * DEG }, // the crisp curved glint, top-left
  tiny: { r: 0.76, at: 42 * DEG, size: 0.065 }, // a dot of light, bottom-right
  reflection: { r: 0.6, from: 105 * DEG, to: 160 * DEG }, // the faint inner reflection, lower left
} as const;
