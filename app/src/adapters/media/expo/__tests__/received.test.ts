// Downloaded files keep the server's name, made safe as one path segment.

import { folderLost, safeName } from '../received';

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

describe('folderLost', () => {
  it('re-picks the folder only when it is gone or its access was taken back', () => {
    expect(folderLost(new Error('java.lang.SecurityException: Permission Denial: writing'))).toBe(true);
    expect(folderLost(new Error('Permission denied'))).toBe(true);
    // A generic "not found" may be the pruned cached copy: not a reason to ask for the folder again.
    expect(folderLost(new Error('File not found'))).toBe(false);
    expect(folderLost(new Error('FileNotFoundException: no such file, missing'))).toBe(false);
    expect(folderLost(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(folderLost(new Error('I/O error'))).toBe(false);
  });
});
