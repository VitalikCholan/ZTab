import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { VITE_API_URL: 'http://127.0.0.1:3000', VITE_NETWORK: 'test' },
    setupFiles: ['./test/setup.ts'],
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['test/**/*.test.ts'] } },
      { extends: true, test: { name: 'dom', environment: 'jsdom', include: ['test/**/*.test.tsx'] } },
    ],
  },
});
