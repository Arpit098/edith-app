// What the runtimeVersion fingerprint covers (contracts/app-updates.md §4): everything native,
// but not the version name/code (a version bump alone mustn't cut an APK off from OTA bundles),
// and not android/ or ios/, which `expo prebuild` regenerates from the config already hashed.
//
// `.kotlin/` is Kotlin 2.x's per-build state (compiler sessions, error logs). Gradle compiles the
// included build node_modules/expo-updates/expo-updates-gradle-plugin in place, so a real compile
// (a cold cache) leaves `.kotlin/` in that hashed directory and a cached one doesn't. That made the
// fingerprint embedded mid-build differ from the one resolved before it (main run 40920049797).
// @expo/fingerprint already ignores build/, .cxx/ and .gradle/ there, but not .kotlin/.
/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips: ['ExpoConfigVersions'],
  ignorePaths: ['android/**/*', 'ios/**/*', '**/.kotlin/**/*'],
};
