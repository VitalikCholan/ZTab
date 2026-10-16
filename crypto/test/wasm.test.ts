import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CryptoError,
  deriveAddress,
  deriveTabAccount,
  inspectPczt,
  loadWasm,
  signPczt,
  validateRecipient,
} from '../src/index.ts';

const expected = JSON.parse(
  readFileSync(new URL('../rust/tests/fixtures/expected.json', import.meta.url), 'utf8'),
) as { ufvk: string; orchardSkHex: string; addresses: Record<string, string> };
const spendSeed = Buffer.from(
  readFileSync(new URL('../rust/tests/fixtures/spend_seed.hex', import.meta.url), 'utf8').trim(),
  'hex',
);
const sweep = new Uint8Array(
  readFileSync(new URL('../../watcher/tests/fixtures/sweep.proved.pczt', import.meta.url)),
);
const RECIPIENT =
  'utest1079uezyzq3c5n7vx8244azpw2wdzevp2rxml8hcjv6qaxnysg9ug78j96ffwsmxqryfelsp5tgk77s8ezu4t8jkcl4s7l48xrgrudmtp';

function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    return (e as CryptoError).code;
  }
  throw new Error('did not throw');
}

beforeAll(async () => {
  await loadWasm(new Uint8Array(readFileSync(new URL('../pkg/ztab_crypto_bg.wasm', import.meta.url))));
});

describe('keys', () => {
  it('derives the fixture account', () => {
    const account = deriveTabAccount('test', new Uint8Array(spendSeed));
    expect(account.ufvk).toBe(expected.ufvk);
    expect(Buffer.from(account.orchardSk).toString('hex')).toBe(expected.orchardSkHex);
  });

  it('derives the watcher participant addresses', () => {
    for (const [index, address] of Object.entries(expected.addresses)) {
      expect(deriveAddress('test', expected.ufvk, Number(index))).toBe(address);
    }
  });

  it('maps Rust errors to codes', () => {
    expect(codeOf(() => deriveTabAccount('test', new Uint8Array(31)))).toBe('internal');
    expect(codeOf(() => deriveTabAccount('testnet' as 'test', new Uint8Array(32)))).toBe('internal');
  });
});

describe('recipient', () => {
  it('accepts an Orchard UA of the network and refuses the rest', () => {
    expect(() => validateRecipient('test', RECIPIENT)).not.toThrow();
    expect(codeOf(() => validateRecipient('main', RECIPIENT))).toBe('invalid_recipient');
    expect(codeOf(() => validateRecipient('test', 'tmEZhbWHTpdKMw5it8YDspUXSMGQyFwovpU'))).toBe('invalid_recipient');
    expect(codeOf(() => validateRecipient('test', 'nonsense'))).toBe('invalid_recipient');
  });
});

describe('pczt', () => {
  it('inspects the proved sweep', () => {
    expect(inspectPczt('test', sweep)).toEqual({
      outputs: [{ address: RECIPIENT, zat: 29_990_000 }],
      feeZat: 10_000,
      totalInZat: 30_000_000,
      txid: '659513d7a836783c8ab08445069de601c5c25b7f422e30ab8f116f5ff0e0f978',
    });
    expect(codeOf(() => inspectPczt('test', sweep.subarray(0, 4000)))).toBe('invalid_pczt');
  });

  it('refuses to sign a mismatch and reports a foreign key', () => {
    const foreignSk = Buffer.from(expected.orchardSkHex, 'hex');
    const seed = new Uint8Array(32);
    const ok = { recipient: RECIPIENT, totalZat: 29_990_000, feeZat: 10_000 };
    expect(codeOf(() => signPczt('test', sweep, foreignSk, seed, { ...ok, totalZat: 1 }))).toBe('pczt_mismatch');
    expect(codeOf(() => signPczt('test', sweep, foreignSk, seed, { ...ok, recipient: expected.addresses['0'] }))).toBe('pczt_mismatch');
    expect(codeOf(() => signPczt('test', sweep, foreignSk, seed, ok))).toBe('sign_failed');
  });

  it('signs the real tab fixture end to end', () => {
    const exp = JSON.parse(readFileSync(new URL('../rust/tests/fixtures/tab/expected.json', import.meta.url), 'utf8')) as {
      ufvk: string; recipient: string; outputZat: number; feeZat: number; txid: string;
    };
    const seed = new Uint8Array(Buffer.from(readFileSync(new URL('../rust/tests/fixtures/tab/spend_seed.hex', import.meta.url), 'utf8').trim(), 'hex'));
    const proved = new Uint8Array(readFileSync(new URL('../rust/tests/fixtures/tab/sweep.proved.pczt', import.meta.url)));
    const account = deriveTabAccount('test', seed);
    expect(account.ufvk).toBe(exp.ufvk);
    const summary = inspectPczt('test', proved);
    expect(summary.txid).toBe(exp.txid);
    const signed = signPczt('test', proved, account.orchardSk, crypto.getRandomValues(new Uint8Array(32)), {
      recipient: exp.recipient, totalZat: exp.outputZat, feeZat: exp.feeZat,
    });
    expect(signed.length).toBeGreaterThan(proved.length);
    expect(inspectPczt('test', signed)).toEqual(summary);
  });
});
