import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url));

export const hkdfFixture = JSON.parse(read('../../../crypto/test/fixtures/hkdf.json').toString('utf8')) as {
  masterHex: string;
  tabId: string;
  groupKeyHex: string;
  participantKeyHex: Record<string, string>;
  tokenHex: { admin: string; group: string; participant0: string };
  tokenHashHex: { admin: string; group: string; participant0: string };
};

export interface TabExpected {
  network: 'test';
  recipient: string;
  outputZat: number;
  feeZat: number;
  totalInZat: number;
  txid: string;
  ufvk: string;
  addresses: string[];
}

const TAB = '../../../crypto/rust/tests/fixtures/tab/';
export const tabExpected = JSON.parse(read(`${TAB}expected.json`).toString('utf8')) as TabExpected;
export const tabSpendSeedHex = read(`${TAB}spend_seed.hex`).toString('utf8').trim();
export const tabSweepPczt = (): Uint8Array => new Uint8Array(read(`${TAB}sweep.proved.pczt`));

export function hex(h: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(h, 'hex'));
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

/** A JSON `Response` for a mocked fetch. */
export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
