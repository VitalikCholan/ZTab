import { defineConfig, devices } from '@playwright/test';

// Specs tagged @phone or @desktop run on that project only; untagged ones run on both.
// The specs share one API and one stub watcher (started by e2e/harness/start.ts), so they run
// serially in a single worker.
export default defineConfig({
  testDir: 'e2e',
  reporter: 'list',
  globalSetup: './e2e/harness/start.ts',
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173' },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] }, grepInvert: /@desktop/ },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@phone/ },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    env: { VITE_API_URL: 'http://127.0.0.1:3000', VITE_NETWORK: 'test' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
