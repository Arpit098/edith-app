// Build-time app config on top of app.json (contracts/app-updates.md).
//
// - versionCode: CI sets EDITH_VERSION_CODE (1000 + run number) so every build can update the last.
// - expo-updates: on only when CI builds with the OTA signing key (EDITH_UPDATES_SIGNING=1), so an
//   APK never runs a bundle that isn't signed. The token header is a placeholder here: the app
//   overrides it at runtime with Arpit's token (expo-updates only allows overriding embedded names).
// - runtimeVersion: the fingerprint of the native side (see fingerprint.config.js).

const UPDATES_URL = process.env.EDITH_UPDATES_URL || 'http://edith:8787/v1/updates/manifest';

module.exports = ({ config }) => {
  const versionCode = Number(process.env.EDITH_VERSION_CODE) || config.android.versionCode;
  const signed = process.env.EDITH_UPDATES_SIGNING === '1';
  return {
    ...config,
    android: { ...config.android, versionCode },
    runtimeVersion: { policy: 'fingerprint' },
    updates: signed
      ? {
          enabled: true,
          url: UPDATES_URL,
          checkAutomatically: 'ON_LOAD', // in the background at launch; never blocks it
          fallbackToCacheTimeout: 0, // a new bundle is used on the next cold start
          enableBsdiffPatchSupport: false, // the server serves whole files
          requestHeaders: { Authorization: 'Bearer -', 'expo-channel-name': 'main' },
          codeSigningCertificate: './certs/updates-certificate.pem',
          codeSigningMetadata: { keyid: 'main', alg: 'rsa-v1_5-sha256' },
        }
      : { enabled: false },
  };
};
