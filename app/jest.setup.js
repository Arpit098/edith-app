// Reanimated and worklets need native code; under jest their own mocks stand in (values jump to
// their targets, as with "Remove animations").
jest.mock('react-native-worklets', () => require('react-native-worklets/src/mock'));
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
