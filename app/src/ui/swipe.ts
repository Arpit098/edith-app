// The swipe-to-reply gesture's maths (ui/SwipeToReply draws it): when a drag becomes a swipe, how
// far the row follows the finger, and when letting go counts.

/** The swipe's distances, in dp. */
export const SWIPE = {
  start: 12, // a horizontal drag this long, and mostly sideways, becomes a swipe (shorter: a tap or a scroll)
  catch: 64, // let go past this and the row is quoted (the reply arrow pops to mark the moment)
  max: 96, // it never moves further than this
} as const;

/** A drag counts as a swipe: to the right, and clearly more sideways than up or down (the list scrolls vertically). */
export function wantsSwipe(dx: number, dy: number): boolean {
  return dx > SWIPE.start && dx > 2 * Math.abs(dy);
}

/** How far the row follows the finger: one to one up to the catch point, then with resistance, never past `max` or to the left. */
export function swipeOffset(dx: number): number {
  if (dx <= 0) return 0;
  if (dx <= SWIPE.catch) return dx;
  return Math.min(SWIPE.max, SWIPE.catch + (dx - SWIPE.catch) * 0.35);
}

export function caught(dx: number): boolean {
  return dx >= SWIPE.catch;
}
