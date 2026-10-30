module.exports = {
  preset: 'jest-expo/android',
  roots: ['<rootDir>/src', '<rootDir>/scripts'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  clearMocks: true,
  setupFiles: ['<rootDir>/jest.setup.js'],
};
