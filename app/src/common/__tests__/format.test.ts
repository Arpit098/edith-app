import { formatBytes, formatIST, timeAgo } from '../format';

describe('format', () => {
  it('shows times in IST (UTC+5:30) whatever the phone zone', () => {
    expect(formatIST(Date.UTC(2026, 9, 29, 12, 35) / 1000)).toBe('29 Oct, 18:05 IST');
    expect(formatIST(Date.UTC(2026, 11, 31, 20, 0) / 1000)).toBe('1 Jan, 01:30 IST'); // crosses midnight and the year
  });

  it('formats sizes and ages', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(15_432_247)).toBe('14.7 MB');
    expect(timeAgo(1000, 1000 + 7200)).toBe('2h ago');
  });
});
