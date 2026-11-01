// Where the header's title goes so it never runs under the back arrow, the status chip or the menu
// (Arpit, 1 Nov: on Commands the chip covered "Co"). The title is centred on the row when it fits
// between the two sides; otherwise (a sub-page with the back arrow and the chip's timer, a narrow
// phone, a large font) it fills the free space after the chip, left-aligned and cut with "…".

export interface HeaderLayout {
  /** The row's width. */
  row: number;
  /** The free space between the left cluster (back arrow + chip) and the menu, gaps included: x and width. */
  freeX: number;
  freeWidth: number;
  /** The title's natural one-line width. */
  title: number;
}

/** Absolute insets from the row's edges. */
export interface TitleBox {
  left: number;
  right: number;
  align: 'center' | 'left';
}

/** Null until the row has been measured (the title stays invisible for that first frame). */
export function titleBox(l: HeaderLayout): TitleBox | null {
  if (l.row <= 0 || l.freeWidth <= 0 || l.title <= 0) return null;
  const left = l.freeX;
  const right = Math.max(0, l.row - l.freeX - l.freeWidth);
  const side = Math.max(left, right); // centred on the row: the same inset both sides
  if (l.title <= l.row - 2 * side) return { left: side, right: side, align: 'center' };
  return { left, right, align: 'left' };
}
