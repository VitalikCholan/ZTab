import { createMaster, fromBase64Url, importBlobKey, inspectPczt } from '@ztab/crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../../src/api/client.ts';
import type { SweepOffer } from '../../src/api/types.ts';
import type { Session } from '../../src/tab/keys.ts';
import { checkWithdraw, MAX_FEE_ZAT, prepareWithdraw, signAndBroadcast } from '../../src/tab/withdraw.ts';
import { hex, json, recipientFixture, tabExpected as E, tabSpendSeedHex, tabSweepPczt } from '../helpers/fixtures.ts';
import { loadTestWasm } from '../helpers/wasm.ts';

const TAB_ID = '0f6d3f4e-7c1b-4a8e-9a9b-2f3c4d5e6f70';
const OTHER_UA = E.addresses[0];

let session: Session;

beforeAll(async () => {
  await loadTestWasm();
  session = {
    tabId: TAB_ID,
    role: 'admin',
    master: createMaster(),
    blobKey: await importBlobKey(createMaster()),
    token: new Uint8Array(32).fill(9),
    fullUrl: 'https://ztab.example/t/x#a=x',
  };
});

function offer(overrides: Partial<SweepOffer['summary']> = {}, b64url = false): SweepOffer {
  const b64 = Buffer.from(tabSweepPczt()).toString(b64url ? 'base64url' : 'base64');
  return {
    pczt_b64: b64,
    summary: {
      inputs_zat: E.totalInZat,
      output_zat: E.outputZat,
      fee_zat: E.feeZat,
      expiry_height: 1_000_000,
      txid: E.txid,
      ...overrides,
    },
  };
}

function mockApi(sweep: SweepOffer) {
  const broadcasts: string[] = [];
  const sweepBodies: unknown[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { pczt_b64?: string; recipient_address?: string };
    if (url.endsWith('/sweep')) {
      sweepBodies.push(body);
      return json(200, sweep);
    }
    broadcasts.push(body.pczt_b64!);
    return json(200, { txid: E.txid });
  });
  return { fetchImpl, broadcasts, sweepBodies, api: new ApiClient('https://api.example', fetchImpl as unknown as typeof fetch) };
}

describe('prepareWithdraw', () => {
  it('ok when the PCZT pays the recipient and the server summary agrees', async () => {
    const { api, sweepBodies } = mockApi(offer());
    const p = await prepareWithdraw(api, session, E.recipient);
    expect(sweepBodies).toEqual([{ recipient_address: E.recipient }]);
    expect(p.ok).toBe(true);
    expect(p.reason).toBeUndefined();
    expect(p.inspected).toMatchObject({ feeZat: E.feeZat, totalInZat: E.totalInZat, txid: E.txid });
    expect(p.inspected.outputs).toEqual([{ address: E.recipient, zat: E.outputZat }]);
  });

  it('accepts base64url pczt_b64 too', async () => {
    const { api } = mockApi(offer({}, true));
    expect((await prepareWithdraw(api, session, E.recipient)).ok).toBe(true);
  });

  it('server summary output_zat + 1 → ok false (amount)', async () => {
    const { api } = mockApi(offer({ output_zat: E.outputZat + 1 }));
    expect(await prepareWithdraw(api, session, E.recipient)).toMatchObject({ ok: false, reason: 'amount' });
  });

  it('server summary fee differs → ok false (fee)', async () => {
    const { api } = mockApi(offer({ fee_zat: E.feeZat - 1 }));
    expect(await prepareWithdraw(api, session, E.recipient)).toMatchObject({ ok: false, reason: 'fee' });
  });

  it('recipient is another UA → ok false (recipient)', async () => {
    const { api } = mockApi(offer());
    expect(await prepareWithdraw(api, session, OTHER_UA)).toMatchObject({ ok: false, reason: 'recipient' });
  });
});

describe('prepareWithdraw with a wallet UA', () => {
  it('a multi-receiver UA whose Orchard receiver is the fixture recipient → ok true', async () => {
    expect(recipientFixture.orchardOnly).toBe(E.recipient);
    const { api, sweepBodies } = mockApi(offer());
    const p = await prepareWithdraw(api, session, recipientFixture.multiReceiver);
    expect(sweepBodies).toEqual([{ recipient_address: recipientFixture.multiReceiver }]);
    expect(p).toMatchObject({ ok: true, recipient: recipientFixture.multiReceiver });
  });
});

describe('checkWithdraw', () => {
  const summary = (feeZat: number) => ({
    inspected: { outputs: [{ address: E.recipient, zat: 1_000_000 }], feeZat, totalInZat: 1_000_000 + feeZat, txid: 'aa' },
    server: { inputs_zat: 1_000_000 + feeZat, output_zat: 1_000_000, fee_zat: feeZat, expiry_height: 1, txid: 'aa' },
  });

  it('a fee above MAX_FEE_ZAT is refused even when the server agrees', () => {
    const { inspected, server } = summary(MAX_FEE_ZAT + 1);
    expect(checkWithdraw(inspected, server, E.recipient)).toEqual({ ok: false, reason: 'fee' });
  });

  it('a fee of exactly MAX_FEE_ZAT passes', () => {
    const { inspected, server } = summary(MAX_FEE_ZAT);
    expect(checkWithdraw(inspected, server, E.recipient)).toEqual({ ok: true });
  });

  it('an empty output list is a recipient mismatch', () => {
    const { inspected, server } = summary(10_000);
    expect(checkWithdraw({ ...inspected, outputs: [] }, server, E.recipient)).toEqual({ ok: false, reason: 'recipient' });
  });
});

describe('signAndBroadcast', () => {
  it('signs for a multi-receiver wallet UA', async () => {
    const { api, broadcasts } = mockApi(offer());
    const prepared = await prepareWithdraw(api, session, recipientFixture.multiReceiver);
    expect(await signAndBroadcast(api, session, prepared, async () => hex(tabSpendSeedHex))).toEqual({ txid: E.txid });
    expect(inspectPczt('test', fromBase64Url(broadcasts[0])!).txid).toBe(E.txid);
  });

  it('signs the fixture and broadcasts a base64url PCZT that inspectPczt still accepts', async () => {
    const { api, broadcasts } = mockApi(offer());
    const prepared = await prepareWithdraw(api, session, E.recipient);
    const seed = hex(tabSpendSeedHex);
    const out = await signAndBroadcast(api, session, prepared, async () => seed);
    expect(out).toEqual({ txid: E.txid });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toMatch(/^[A-Za-z0-9_-]+$/);
    const signed = fromBase64Url(broadcasts[0]);
    expect(signed).not.toBeNull();
    expect(signed!.length).toBeGreaterThan(prepared.pczt.length);
    expect(inspectPczt('test', signed!).txid).toBe(E.txid);
    expect(seed.every((b) => b === 0)).toBe(true);
  });

  it('with ok false throws before any crypto call or request', async () => {
    const { api, fetchImpl } = mockApi(offer({ output_zat: E.outputZat + 1 }));
    const prepared = await prepareWithdraw(api, session, E.recipient);
    fetchImpl.mockClear();
    const getSpendSeed = vi.fn(async () => hex(tabSpendSeedHex));
    await expect(signAndBroadcast(api, session, prepared, getSpendSeed)).rejects.toThrow('not_ok');
    expect(getSpendSeed).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('zeroes the seed even when signing refuses', async () => {
    const { api, fetchImpl } = mockApi(offer());
    const prepared = await prepareWithdraw(api, session, E.recipient);
    fetchImpl.mockClear();
    const foreign = createMaster();
    await expect(signAndBroadcast(api, session, prepared, async () => foreign)).rejects.toMatchObject({ code: 'pczt_mismatch' });
    expect(foreign.every((b) => b === 0)).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
