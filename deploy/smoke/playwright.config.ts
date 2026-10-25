// Smoke for the composed stack. Run by deploy/rehearsal.sh; by hand against a kept stack:
//   NODE_EXTRA_CA_CERTS=$PWD/deploy/smoke/.ca.crt \
//     pnpm --filter @ztab/pwa exec playwright test --config ../deploy/smoke/playwright.config.ts
// Trust: rehearsal.sh exports Caddy's local root CA to deploy/smoke/.ca.crt. Node (the `request`
// fixture) trusts it through NODE_EXTRA_CA_CERTS; Chromium trusts exactly the keys of that CA's
// chain through --ignore-certificate-errors-spki-list. No blanket ignoreHTTPSErrors: a service
// worker is only registered on an origin whose certificate Chromium accepts.
import { defineConfig, devices } from '@playwright/test';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function spkiHashes(): string[] {
  const files = (process.env.SMOKE_CA_CERTS ?? path.join(__dirname, '.ca.crt'))
    .split(path.delimiter)
    .filter((f) => f && existsSync(f));
  return files.flatMap((f) =>
    (readFileSync(f, 'utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []).map(
      (pem) =>
        createHash('sha256')
          .update(new X509Certificate(pem).publicKey.export({ type: 'spki', format: 'der' }))
          .digest('base64'),
    ),
  );
}

const hashes = spkiHashes();

export default defineConfig({
  testDir: '.',
  testMatch: 'stack.spec.ts',
  outputDir: path.join(__dirname, 'test-results'),
  reporter: 'list',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  use: {
    ...devices['Desktop Chrome'],
    launchOptions: {
      args: hashes.length ? [`--ignore-certificate-errors-spki-list=${hashes.join(',')}`] : [],
    },
  },
});
