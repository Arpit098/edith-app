// Expo config plugin: sign the release build with EDITH's release key when CI provides it.
//
// The keystore never lives in the repo: CI decodes it from GitHub Secrets into $RUNNER_TEMP and
// passes its path and passwords in the environment (EDITH_KEYSTORE_PATH, EDITH_KEYSTORE_PASSWORD,
// EDITH_KEY_ALIAS, EDITH_KEY_PASSWORD). It's a PKCS12 keystore (made with openssl), hence storeType.
// Without EDITH_KEYSTORE_PATH the release build keeps Expo's public debug key, which is only for
// testing: the server never offers such an APK as an update (contracts/app-updates.md §6).
const { withAppBuildGradle } = require('expo/config-plugins');

const RELEASE_SIGNING = `
        release {
            if (System.getenv('EDITH_KEYSTORE_PATH')) {
                storeFile file(System.getenv('EDITH_KEYSTORE_PATH'))
                storeType 'pkcs12'
                storePassword System.getenv('EDITH_KEYSTORE_PASSWORD')
                keyAlias System.getenv('EDITH_KEY_ALIAS')
                keyPassword System.getenv('EDITH_KEY_PASSWORD')
            }
        }`;

function addReleaseSigning(gradle) {
  if (gradle.includes("System.getenv('EDITH_KEYSTORE_PATH')")) return gradle; // already applied
  // 1. A `release` signing config next to the template's `debug` one.
  const debugConfig = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/;
  if (!debugConfig.test(gradle)) throw new Error('with-release-signing: signingConfigs.debug not found in app/build.gradle');
  let out = gradle.replace(debugConfig, `$1${RELEASE_SIGNING}`);
  // 2. The release build type uses it when the keystore is there, else the debug key.
  const releaseType = /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
  if (!releaseType.test(out)) throw new Error('with-release-signing: buildTypes.release signingConfig not found');
  out = out.replace(releaseType, "$1signingConfig System.getenv('EDITH_KEYSTORE_PATH') ? signingConfigs.release : signingConfigs.debug");
  return out;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') throw new Error('with-release-signing: expected a Groovy build.gradle');
    cfg.modResults.contents = addReleaseSigning(cfg.modResults.contents);
    return cfg;
  });
};

module.exports.addReleaseSigning = addReleaseSigning;
