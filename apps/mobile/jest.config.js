/**
 * Plain-node Jest: only src/lib/** (no expo-*, react-native or @maplibre imports) is unit-tested.
 * Native-dependent code (screens, components, services) is type-checked by `tsc` but not executed here.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@clearwater/shared$': '<rootDir>/../../packages/shared/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json', diagnostics: true }],
  },
  collectCoverageFrom: ['src/lib/**/*.ts'],
};
