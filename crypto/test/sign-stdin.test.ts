import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = new URL('../scripts/sign-stdin.ts', import.meta.url).pathname;
const sweep = readFileSync(new URL('../../watcher/tests/fixtures/sweep.proved.pczt', import.meta.url));
const RECIPIENT =
  'utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp';

function run(request: object) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify(request), encoding: 'utf8' });
}

describe('scripts/sign-stdin.ts', () => {
  it('derives the UFVK, then fails with sign_failed for a seed that owns nothing in the PCZT', () => {
    const r = run({
      network: 'test',
      spendSeedHex: readFileSync(new URL('../rust/tests/fixtures/spend_seed.hex', import.meta.url), 'utf8').trim(),
      pcztB64: sweep.toString('base64url'),
      recipient: RECIPIENT,
      totalZat: 29_990_000,
      feeZat: 10_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('sign_failed');
    expect(r.stdout).toBe('');
  });

  it('refuses a mismatch before signing', () => {
    const r = run({
      network: 'test',
      spendSeedHex: '00'.repeat(32),
      pcztB64: sweep.toString('base64url'),
      recipient: RECIPIENT,
      totalZat: 1,
      feeZat: 10_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('pczt_mismatch');
  });
});
