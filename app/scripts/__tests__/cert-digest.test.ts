import { spawnSync } from 'child_process';
import path from 'path';

const SCRIPT = path.join(__dirname, '..', 'cert-digest.sh');
const HEX = '2b6cd36eea02209b55d97d7a7820e1f681a6b160673a4a49f22b439f3fd802ab';
const PIN = '2B:6C:D3:6E:EA:02:20:9B:55:D9:7D:7A:78:20:E1:F6:81:A6:B1:60:67:3A:4A:49:F2:2B:43:9F:3F:D8:02:AB';

function parse(...lines: string[]) {
  const r = spawnSync('bash', [SCRIPT], { input: lines.join('\n') + '\n', encoding: 'utf8' });
  return { status: r.status, out: r.stdout.trim() };
}

describe('scripts/cert-digest.sh (apksigner --print-certs → pinned form)', () => {
  it.each([
    ['Signer #1', `Signer #1 certificate SHA-256 digest: ${HEX}`],
    ['Signer (minSdk…)', `Signer (minSdkVersion=24, maxSdkVersion=2147483647) certificate SHA-256 digest: ${HEX}`],
    ['V2 Signer:', `V2 Signer: certificate SHA-256 digest: ${HEX}`],
    ['V3 Signer:', `V3 Signer: certificate SHA-256 digest: ${HEX}`],
  ])('reads %s', (_name, line) => {
    expect(parse('Verifies', line, 'Signer #1 certificate SHA-1 digest: abcd')).toEqual({ status: 0, out: PIN });
  });

  it('accepts the same certificate on several scheme lines', () => {
    expect(parse(`V2 Signer: certificate SHA-256 digest: ${HEX}`, `V3 Signer: certificate SHA-256 digest: ${HEX.toUpperCase()}  `)).toEqual({ status: 0, out: PIN });
  });

  it('fails on zero or two-plus certificates', () => {
    expect(parse(`V2 Signer: certificate SHA-256 digest: ${HEX}`, `V3 Signer: certificate SHA-256 digest: ${'1'.repeat(64)}`).status).toBe(1);
    expect(parse('Verifies').status).toBe(1);
    expect(parse('').status).toBe(1);
  });
});
