// The header title never overlaps the back arrow, the status chip or the menu (Arpit, 1 Nov: on
// Commands the chip covered "Co"). Widths in dp, measured off the header at 360 dp: 16 padding, the
// back arrow 28, the chip with its timer ~120, the menu 40, 8 between each.

import { titleBox } from '../headerTitle';

const ROW = 360;
const MENU = 16 + 40 + 8; // padding, button, gap: from the right edge to the free space
// The free space between the chip and the menu: [x, width].
const free = (back: boolean, chip: number) => {
  const x = 16 + (back ? 28 + 8 : 0) + chip + 8;
  return { freeX: x, freeWidth: ROW - x - MENU };
};
// A title's natural width at 22 sp bold with 1.5 letter spacing (~14.5 dp a letter), times the font scale.
const width = (title: string, scale = 1) => Math.ceil(title.length * 14.5 * scale);

const overlaps = (box: NonNullable<ReturnType<typeof titleBox>>, f: { freeX: number; freeWidth: number }) => box.left < f.freeX || ROW - box.right > f.freeX + f.freeWidth;

describe('header title', () => {
  it('waits for the measurements', () => {
    expect(titleBox({ row: 0, freeX: 0, freeWidth: 0, title: 0 })).toBeNull();
    expect(titleBox({ row: ROW, ...free(false, 40), title: 0 })).toBeNull();
  });

  it('stays centred on the home screen when it fits between the chip and the menu', () => {
    const f = free(false, 40); // the idle chip: dot and orb
    expect(titleBox({ row: ROW, ...f, title: width('E.D.I.T.H') })).toEqual({ left: 64, right: 64, align: 'center' });
  });

  it('never runs under the chip on any page, at 360 dp, at normal and large font', () => {
    const titles = ['E.D.I.T.H', 'Live', 'Sessions', 'Tools', 'Settings', 'Commands', 'Approvals', 'Train wake word'];
    for (const back of [false, true]) {
      for (const chip of [40, 120, 150]) {
        for (const scale of [1, 1.3, 2]) {
          for (const t of titles) {
            const f = free(back, chip);
            const box = titleBox({ row: ROW, ...f, title: Math.min(ROW, width(t, scale)) })!;
            expect(overlaps(box, f)).toBe(false);
            expect(box.left + box.right).toBeLessThan(ROW);
          }
        }
      }
    }
  });

  it('on a sub-page with the timer, starts after the chip and is cut instead', () => {
    const f = free(true, 120); // the screenshot: ← [● orb 6:03] Commands
    expect(titleBox({ row: ROW, ...f, title: width('Commands') })).toEqual({ left: f.freeX, right: MENU, align: 'left' });
  });
});
