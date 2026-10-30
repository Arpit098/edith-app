import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', 'check-permissions.sh');
const REAL_ALLOWLIST = path.join(__dirname, '..', '..', 'android-permissions.txt');

let dir: string;
beforeAll(() => (dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perms-'))));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function check(allow: string, ...lines: string[]) {
  const file = path.join(dir, 'allow.txt');
  fs.writeFileSync(file, allow);
  const r = spawnSync('bash', [SCRIPT, file], { input: lines.join('\n') + '\n', encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
}

const dump = (...names: string[]) => ['package: com.arpit.edith', 'permission: com.arpit.edith.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION', ...names.map((n) => `uses-permission: name='${n}'`)];

describe('scripts/check-permissions.sh (aapt2 dump permissions → exact allowlist)', () => {
  it('passes on exactly the allowlist (comments, spacing and order ignored)', () => {
    const r = check('# x\nandroid.permission.INTERNET   # why\n\nandroid.permission.CAMERA\n', ...dump('android.permission.CAMERA', 'android.permission.INTERNET'));
    expect(r).toMatchObject({ status: 0, out: 'android.permission.CAMERA\nandroid.permission.INTERNET' });
  });

  it('fails on a permission the allowlist lacks, and on one the APK lacks', () => {
    const extra = check('android.permission.INTERNET\n', ...dump('android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS'));
    expect(extra.status).toBe(1);
    expect(extra.err).toContain('+ android.permission.POST_NOTIFICATIONS');
    const missing = check('android.permission.INTERNET\nandroid.permission.CAMERA\n', ...dump('android.permission.INTERNET'));
    expect(missing.status).toBe(1);
    expect(missing.err).toContain('- android.permission.CAMERA');
  });

  it.each(['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.READ_MEDIA_IMAGES', 'android.permission.ACCESS_MEDIA_LOCATION'])('never allows %s, even when listed', (p) => {
    const r = check(`android.permission.INTERNET\n${p}\n`, `uses-permission: name='android.permission.INTERNET'`, `uses-permission: name='${p}' maxSdkVersion='32'`);
    expect(r.status).toBe(1);
    expect(r.err).toContain('never allowed');
  });

  it('reads uses-permission-sdk-23 lines, and fails on empty input', () => {
    expect(check('android.permission.CAMERA\n', "uses-permission-sdk-23: name='android.permission.CAMERA'").status).toBe(0);
    expect(check('android.permission.CAMERA\n', '').status).toBe(1);
  });

  it('the real allowlist has no storage or media permission and includes CAMERA', () => {
    const names = fs.readFileSync(REAL_ALLOWLIST, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
    expect(names).toContain('android.permission.CAMERA');
    expect(names.filter((n) => /STORAGE|READ_MEDIA|MEDIA_LOCATION/.test(n))).toEqual([]);
  });
});
