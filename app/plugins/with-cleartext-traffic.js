// Expo config plugin: allow plain http:// to the App API.
//
// The App API is http on edith's Tailscale address (contracts/events.md, "App API"). Tailscale's
// WireGuard tunnel already encrypts it end to end, and the API is reachable only inside the
// tailnet, so Android's cleartext block has nothing to protect here. Android can't scope this to
// an IP range (network security config only takes host names), so it is set app-wide.
const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withCleartextTraffic(config) {
  return withAndroidManifest(config, (cfg) => {
    const application = cfg.modResults.manifest.application?.[0];
    if (!application) throw new Error('AndroidManifest.xml has no <application>');
    application.$['android:usesCleartextTraffic'] = 'true';
    return cfg;
  });
};
