// Expo's Babel preset (the one Metro uses by default). jest-expo/android needs it spelled out.
// The preset adds react-native-worklets/plugin itself (as its last plugin) because the package is
// installed (babel-preset-expo build/configs/expo.js), so it isn't listed again here: that would run
// it twice.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['expo/internal/babel-preset'] };
};
