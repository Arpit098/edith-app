import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildUpdate, writeUpdate, stableUuid } = require('../ota.js');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edith-ota-'));
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(path.join(dist, '_expo/static/js/android'), { recursive: true });
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, '_expo/static/js/android/index-abc.hbc'), 'bundle bytes');
  fs.writeFileSync(path.join(dist, 'assets/5a29'), 'font bytes');
  fs.writeFileSync(
    path.join(dist, 'metadata.json'),
    JSON.stringify({ version: 0, bundler: 'metro', fileMetadata: { android: { bundle: '_expo/static/js/android/index-abc.hbc', assets: [{ path: 'assets/5a29', ext: 'ttf' }] } } }),
  );
  return dir;
}

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

const base = {
  runtimeVersion: 'rv1',
  privateKeyPem,
  certificatePem: publicKeyPem,
  baseUrl: 'http://edith:8787',
  sha: 'deadbeef',
  runId: 42,
  now: new Date('2026-10-29T12:30:00Z'),
};

describe('scripts/ota.js', () => {
  it('builds a manifest per the contract and signs its exact bytes', () => {
    const dir = fixture();
    const built = buildUpdate({ ...base, dir, expoConfig: { name: 'EDITH' } });
    const manifest = JSON.parse(built.manifestBytes.toString('utf8'));
    const bundleSha = crypto.createHash('sha256').update('bundle bytes').digest();
    expect(manifest).toMatchObject({
      createdAt: '2026-10-29T12:30:00.000Z',
      runtimeVersion: 'rv1',
      launchAsset: {
        hash: bundleSha.toString('base64url'),
        key: crypto.createHash('md5').update('bundle bytes').digest('hex'),
        contentType: 'application/javascript',
        url: `http://edith:8787/v1/updates/assets/${bundleSha.toString('hex')}`,
      },
      assets: [{ contentType: 'font/ttf', fileExtension: '.ttf' }],
      metadata: { channel: 'main', sha: 'deadbeef' },
      extra: { expoClient: { name: 'EDITH' } },
    });
    expect(manifest.launchAsset.fileExtension).toBeUndefined();
    expect(manifest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const m = /^sig="([^"]+)", keyid="main", alg="rsa-v1_5-sha256"$/.exec(built.sig);
    expect(m).not.toBeNull();
    const ok = crypto.verify('sha256', built.manifestBytes, { key: publicKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(m![1]!, 'base64'));
    expect(ok).toBe(true);

    expect(built.update).toMatchObject({ id: manifest.id, createdAt: 1793277000, channel: 'main', platform: 'android', run_id: 42 });
    expect(built.update.files[0]).toMatchObject({ path: 'dist/_expo/static/js/android/index-abc.hbc', sha256: bundleSha.toString('hex'), size: 12, launch: true });

    writeUpdate(dir, built);
    expect(fs.readFileSync(path.join(dir, 'manifest.json'))).toEqual(built.manifestBytes); // served verbatim
    expect(fs.readFileSync(path.join(dir, 'manifest.sig'), 'utf8')).toBe(built.sig);
  });

  it('refuses a key that does not match the certificate the APK embeds', () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => buildUpdate({ ...base, dir: fixture(), certificatePem: other })).toThrow(/does not match the certificate/);
  });

  it('needs an android bundle', () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'dist/metadata.json'), JSON.stringify({ fileMetadata: {} }));
    expect(() => buildUpdate({ ...base, dir })).toThrow(/no android bundle/);
  });

  it('derives stable ids', () => {
    expect(stableUuid('a', 'b')).toBe(stableUuid('a', 'b'));
    expect(stableUuid('a', 'b')).not.toBe(stableUuid('a', 'c'));
  });
});
