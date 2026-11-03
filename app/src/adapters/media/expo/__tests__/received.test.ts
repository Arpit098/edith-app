// Downloaded files keep the server's name, made safe as one path segment.

import { safeName } from '../received';

describe('safeName', () => {
  it('keeps ordinary names and removes separators, controls and leading dots', () => {
    expect(safeName('Plan v2.pdf')).toBe('Plan v2.pdf');
    expect(safeName('../../etc/passwd')).toBe('__.._etc_passwd');
    expect(safeName('a\\b:c*?.txt')).toBe('a_b_c__.txt');
    expect(safeName('.hidden')).toBe('_hidden');
    expect(safeName('x\u0000y\n.md')).toBe('x_y_.md');
    expect(safeName('')).toBe('file');
    expect(safeName('n'.repeat(300))).toHaveLength(120);
  });
});
