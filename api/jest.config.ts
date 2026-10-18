import type { Config } from 'jest';

// Nest 12 ships ESM only, so the project and jest run as native ESM
// (NODE_OPTIONS=--experimental-vm-modules, set in the package scripts).
const base: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  modulePathIgnorePatterns: ['<rootDir>/dist'],
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }],
  },
};

const config: Config = { ...base, testRegex: 'src/.*\\.spec\\.ts$' };

export default config;
