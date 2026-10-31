// The thinking bubble's geometry (ui/ThinkingBubble draws it). The rim is an SVG path computed in a
// worklet on the UI thread, once per frame while it animates; `t` is the cycle's phase, 0..1, and the
// rim is periodic in it (whole multiples of 2π), so a repeating 0 → 1 loops with no jump. The glints
// and the reflection are still: plain paths, computed once.
//
// Angles are in SVG's frame (y down): 0 is right, π/2 the bottom, π the left, 3π/2 the top.

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

const deg = (d: number) => (d * Math.PI) / 180;
const at = (cx: number, cy: number, r: number, a: number) => `${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`;

/** An open arc on the circle of radius r round (cx, cy), from angle `from` to `to` (to > from), for a stroke. */
export function arcPath(cx: number, cy: number, r: number, from: number, to: number): string {
  const large = to - from > Math.PI ? 1 : 0;
  return `M${at(cx, cy, r, from)}A${f(r)} ${f(r)} 0 ${large} 1 ${at(cx, cy, r, to)}`;
}

/**
 * A crescent hugging the inside of the circle of radius r, from angle `from` to `to` (less than half
 * a turn): the circle's own arc on the outside and a flatter arc back on the inside, so it is
 * `thickness` thick in the middle and tapers to sharp points at both ends. A crisp specular glint.
 */
export function crescentPath(cx: number, cy: number, r: number, from: number, to: number, thickness: number): string {
  const half = r * Math.sin((to - from) / 2); // half the chord
  const sag = r - Math.sqrt(r * r - half * half); // how far the outer arc bulges from the chord
  const inner = Math.max(sag - thickness, sag * 0.05); // the inner arc's bulge
  const r2 = (inner * inner + half * half) / (2 * inner); // the circle through both ends with that bulge
  return `M${at(cx, cy, r, from)}A${f(r)} ${f(r)} 0 0 1 ${at(cx, cy, r, to)}A${f(r2)} ${f(r2)} 0 0 0 ${at(cx, cy, r, from)}Z`;
}

/** The still parts, as shares of the bubble's radius R, centred on (c, c). */
export function bubbleHighlights(c: number, R: number) {
  return {
    // The main glint: a curved crescent just inside the rim at the top-left (about 10 to 11 o'clock).
    glint: crescentPath(c, c, R * 0.76, deg(196), deg(268), R * 0.11),
    // The small one opposite, at the bottom-right: a dot.
    spot: { cx: c + R * 0.62 * Math.cos(deg(42)), cy: c + R * 0.62 * Math.sin(deg(42)), r: R * 0.065 },
    // A faint reflection along the inside of the bottom.
    reflection: arcPath(c, c, R * 0.8, deg(62), deg(150)),
  };
}
