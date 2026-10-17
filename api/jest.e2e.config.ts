import type { Config } from 'jest';

// Same ESM setup as jest.config.ts (see the note there).
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }],
  },
  testRegex: 'test/.*\\.e2e-spec\\.ts$',
  setupFiles: ['<rootDir>/test/set-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
};

export default config;
