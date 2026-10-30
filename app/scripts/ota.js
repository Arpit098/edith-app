#!/usr/bin/env node
// Builds the signed OTA update that CI uploads as the `edith-ota` artifact
// (contracts/app-updates.md §2): update.json, manifest.json (the exact signed bytes) and
// manifest.sig (the expo-signature header value), next to the `expo export` output in dist/.
//
//   node scripts/ota.js --dir <artifact dir containing dist/> --runtime-version <rv> --key <private key pem>
//        --cert <certificate pem> --base-url http://edith:8787 --sha <git sha> --run-id <n> [--expo-config <json file>]
//        [--release-notes <json file>]
//
// The signature is RSA PKCS#1 v1.5 over SHA-256 of the manifest bytes, which is what expo-updates
// verifies (SHA256withRSA). The script checks its own signature against the certificate that the
// APK embeds, so a key that doesn't match that certificate fails the build instead of the phone.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONTENT_TYPES = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  json: 'application/json',
};

function digest(bytes, algorithm, encoding) {
  return crypto.createHash(algorithm).update(bytes).digest(encoding);
}

/** A UUID-shaped id derived from the inputs, so the same build always gets the same id. */
function stableUuid(...parts) {
  const h = digest(parts.join('\n'), 'sha256', 'hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function describe(dir, rel, contentType, baseUrl) {
  const bytes = fs.readFileSync(path.join(dir, rel));
  const sha256 = digest(bytes, 'sha256', 'hex');
  return {
    file: { path: rel, sha256, size: bytes.length, contentType },
    asset: {
      hash: digest(bytes, 'sha256', 'base64url'),
      key: digest(bytes, 'md5', 'hex'),
      contentType,
      url: `${baseUrl}/v1/updates/assets/${sha256}`,
    },
  };
}

/**
 * @param {object} o
 * @param {string} o.dir         artifact directory; the export is in <dir>/dist
 * @param {string} o.runtimeVersion
 * @param {string} o.privateKeyPem
 * @param {string} o.certificatePem  the certificate (or public key) the APK verifies with
 * @param {string} o.baseUrl
 * @param {string} o.sha
 * @param {number} o.runId
 * @param {object} [o.expoConfig]
 * @param {object} [o.releaseNotes]  {new, fixes, changes, details} (scripts/release-notes.js)
 * @param {Date}   [o.now]
 */
function buildUpdate(o) {
  const dist = path.join(o.dir, 'dist');
  const metadata = JSON.parse(fs.readFileSync(path.join(dist, 'metadata.json'), 'utf8'));
  const android = metadata.fileMetadata && metadata.fileMetadata.android;
  if (!android || !android.bundle) throw new Error('dist/metadata.json has no android bundle (run `expo export --platform android`)');

  const launch = describe(o.dir, path.posix.join('dist', android.bundle), 'application/javascript', o.baseUrl);
  const assets = (android.assets || []).map((a) => {
    const ext = String(a.ext || '').replace(/^\./, '');
    const d = describe(o.dir, path.posix.join('dist', a.path), CONTENT_TYPES[ext] || 'application/octet-stream', o.baseUrl);
    return { ...d, asset: { ...d.asset, fileExtension: ext ? `.${ext}` : undefined } };
  });

  const now = o.now || new Date();
  const id = stableUuid(o.runtimeVersion, launch.file.sha256, String(o.runId), o.sha);
  const manifest = {
    id,
    createdAt: now.toISOString(),
    runtimeVersion: o.runtimeVersion,
    launchAsset: launch.asset,
    assets: assets.map((a) => a.asset),
    // Manifest metadata values are strings (expo-updates keeps them flat), so the notes go in as JSON.
    metadata: { channel: 'main', sha: o.sha, ...(o.releaseNotes ? { release_notes: JSON.stringify(o.releaseNotes) } : {}) },
    extra: o.expoConfig ? { expoClient: o.expoConfig } : {},
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');

  const signature = crypto.sign('sha256', manifestBytes, { key: o.privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING });
  if (!crypto.verify('sha256', manifestBytes, { key: crypto.createPublicKey(o.certificatePem), padding: crypto.constants.RSA_PKCS1_PADDING }, signature)) {
    throw new Error('The OTA signing key does not match the certificate the APK embeds (app/certs/updates-certificate.pem)');
  }
  const sig = `sig="${signature.toString('base64')}", keyid="main", alg="rsa-v1_5-sha256"`;

  const update = {
    id,
    createdAt: Math.floor(now.getTime() / 1000),
    runtimeVersion: o.runtimeVersion,
    channel: 'main',
    platform: 'android',
    sha: o.sha,
    run_id: o.runId,
    files: [{ ...launch.file, launch: true }, ...assets.map((a) => a.file)],
    ...(o.releaseNotes ? { release_notes: o.releaseNotes } : {}),
  };
  return { manifestBytes, sig, update };
}

function writeUpdate(dir, built) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), built.manifestBytes);
  fs.writeFileSync(path.join(dir, 'manifest.sig'), built.sig);
  fs.writeFileSync(path.join(dir, 'update.json'), JSON.stringify(built.update, null, 2) + '\n');
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--')) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ['dir', 'runtime-version', 'key', 'cert', 'base-url', 'sha', 'run-id']) {
    if (!out[k]) throw new Error(`--${k} is required`);
  }
  return out;
}

if (require.main === module) {
  try {
    const a = args(process.argv.slice(2));
    const built = buildUpdate({
      dir: a.dir,
      runtimeVersion: a['runtime-version'],
      privateKeyPem: fs.readFileSync(a.key, 'utf8'),
      certificatePem: fs.readFileSync(a.cert, 'utf8'),
      baseUrl: a['base-url'].replace(/\/+$/, ''),
      sha: a.sha,
      runId: Number(a['run-id']),
      expoConfig: a['expo-config'] ? JSON.parse(fs.readFileSync(a['expo-config'], 'utf8')) : undefined,
      releaseNotes: a['release-notes'] ? JSON.parse(fs.readFileSync(a['release-notes'], 'utf8')) : undefined,
    });
    writeUpdate(a.dir, built);
    console.log(`OTA update ${built.update.id}: runtime ${built.update.runtimeVersion}, ${built.update.files.length} files`);
  } catch (e) {
    console.error(`ota.js: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { buildUpdate, writeUpdate, stableUuid };
