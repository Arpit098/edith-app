// The thinking bubble's geometry (ui/ThinkingBubble draws it): SVG path strings computed in
// worklets on the UI thread, once per frame while it animates. `t` is the cycle's phase, 0..1; every
// shape is periodic in it (whole multiples of 2π), so a repeating 0 → 1 loops with no jump.

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

/** The inner swirl bands: long thin loops at different tilts, each turning its own way. */
export const BANDS = [
  { length: 0.78, width: 0.3, tilt: 0.4, turns: 1, drift: 0 },
  { length: 0.66, width: 0.42, tilt: 2.2, turns: -1, drift: 2.1 },
  { length: 0.52, width: 0.22, tilt: 4.1, turns: 2, drift: 4.2 },
] as const;

/**
 * Band `i` as an ellipse (two SVG arcs), slightly off-centre and breathing, turned by `t`: the
 * swirl inside the orb. Its outer edge stays within r of the centre.
 */
export function bandPath(cx: number, cy: number, r: number, t: number, i: number): string {
  'worklet';
  const b = BANDS[i]!;
  const phase = TAU * t;
  const angle = b.tilt + b.turns * phase;
  const off = r * 0.1;
  const ox = cx + off * Math.cos(phase + b.drift);
  const oy = cy + off * Math.sin(phase + b.drift);
  const rx = r * b.length * (1 + 0.08 * Math.sin(phase + b.drift)); // ≤ 0.78·1.08 + 0.1 < 1
  const ry = r * b.width * (1 + 0.15 * Math.sin(2 * phase + b.drift));
  const dx = rx * Math.cos(angle);
  const dy = rx * Math.sin(angle);
  const deg = f(((((angle * 180) / Math.PI) % 180) + 180) % 180); // an ellipse repeats every half turn
  const arc = `A${f(rx)} ${f(ry)} ${deg} 1 0`;
  return `M${f(ox + dx)} ${f(oy + dy)}${arc} ${f(ox - dx)} ${f(oy - dy)}${arc} ${f(ox + dx)} ${f(oy + dy)}Z`;
}
