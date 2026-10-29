// Expo's Babel preset (the one Metro uses by default). jest-expo/android needs it spelled out.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['expo/internal/babel-preset'] };
};
