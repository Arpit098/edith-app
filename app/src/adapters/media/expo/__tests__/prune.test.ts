// What startup deletes from the caches, and when a downloaded file EDITH sent is reused.

import { KEEP_MS, RECEIVED_KEEP_MS, toPrune, usableCopy } from '../prune';

const DAY = 86400_000;
const NOW = 100 * DAY;

describe('toPrune', () => {
  it('deletes by age and keeps the total within the cap, oldest first', () => {
    const files = [
      { n: 'new', size: 60, mtime: NOW - DAY },
      { n: 'mid', size: 60, mtime: NOW - 2 * DAY },
      { n: 'old', size: 1, mtime: NOW - 9 * DAY },
    ];
    expect(toPrune(files, NOW, KEEP_MS, 100).map((f) => f.n)).toEqual(['mid', 'old']);
    expect(toPrune(files, NOW).map((f) => f.n)).toEqual(['old']);
  });

  it('keeps downloads of sent files only for the server’s 7 days', () => {
    expect(RECEIVED_KEEP_MS).toBe(7 * DAY);
    const files = [
      { n: '6d', size: 1, mtime: NOW - 6 * DAY },
      { n: '7d+1m', size: 1, mtime: NOW - 7 * DAY - 60_000 },
    ];
    expect(toPrune(files, NOW, RECEIVED_KEEP_MS).map((f) => f.n)).toEqual(['7d+1m']);
  });
});

describe('usableCopy', () => {
  it('reuses a complete copy under the same id within 7 days', () => {
    expect(usableCopy({ exists: true, size: 2048, mtime: NOW - DAY }, 2048, NOW)).toBe(true);
    expect(usableCopy({ exists: true, size: 2048, mtime: NOW - DAY }, -1, NOW)).toBe(true); // size unknown
    expect(usableCopy({ exists: true, size: 2048, mtime: null }, 2048, NOW)).toBe(true); // mtime unreadable
  });

  it('downloads again when the copy is missing, a different size, or past 7 days', () => {
    expect(usableCopy({ exists: false, size: 0, mtime: null }, 2048, NOW)).toBe(false);
    expect(usableCopy({ exists: true, size: 1024, mtime: NOW }, 2048, NOW)).toBe(false);
    expect(usableCopy({ exists: true, size: 2048, mtime: NOW - 7 * DAY - 1 }, 2048, NOW)).toBe(false);
    expect(usableCopy({ exists: true, size: 2048, mtime: NOW - 7 * DAY }, 2048, NOW)).toBe(true);
  });
});
