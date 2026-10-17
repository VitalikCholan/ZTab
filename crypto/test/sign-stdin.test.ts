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
  it('derives the UFVK, then is refused with pczt_mismatch for a seed whose key the PCZT outputs are not encrypted to', () => {
    const r = run({
      network: 'test',
      spendSeedHex: readFileSync(new URL('../rust/tests/fixtures/spend_seed.hex', import.meta.url), 'utf8').trim(),
      pcztB64: sweep.toString('base64url'),
      recipient: RECIPIENT,
      totalZat: 29_990_000,
      feeZat: 10_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('pczt_mismatch');
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

  it('derives the UFVK and addresses 0 and 1 for the fixture seed (op derive)', () => {
    const expected = JSON.parse(
      readFileSync(new URL('../rust/tests/fixtures/expected.json', import.meta.url), 'utf8'),
    ) as { ufvk: string; addresses: Record<string, string> };
    const r = run({
      op: 'derive',
      network: 'test',
      spendSeedHex: readFileSync(new URL('../rust/tests/fixtures/spend_seed.hex', import.meta.url), 'utf8').trim(),
      participantsCount: 2,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ufvk: expected.ufvk,
      addresses: [expected.addresses['0'], expected.addresses['1']],
    });
  });
});
