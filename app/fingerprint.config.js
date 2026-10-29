// What the runtimeVersion fingerprint covers (contracts/app-updates.md §4): everything native,
// but not the version name/code (a version bump alone mustn't cut an APK off from OTA bundles),
// and not android/ or ios/, which `expo prebuild` regenerates from the config already hashed.
/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips: ['ExpoConfigVersions'],
  ignorePaths: ['android/**/*', 'ios/**/*'],
};
