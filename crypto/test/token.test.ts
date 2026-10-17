import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveTabKeys, deriveToken, encodeToken, hashToken } from '../src/index.ts';

const v = JSON.parse(readFileSync(new URL('./fixtures/hkdf.json', import.meta.url), 'utf8')) as {
  masterHex: string;
  tabId: string;
  groupKeyHex: string;
  participantKeyHex: Record<string, string>;
  tokenHex: Record<'admin' | 'group' | 'participant0', string>;
  tokenHashHex: Record<'admin' | 'group' | 'participant0', string>;
};
const master = new Uint8Array(Buffer.from(v.masterHex, 'hex'));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const OTHER_TAB = '1a2b3c4d-0000-4000-8000-000000000001';

describe('access tokens', () => {
  it('match the vectors for admin, group and participant 0', async () => {
    const group = new Uint8Array(Buffer.from(v.groupKeyHex, 'hex'));
    const p0 = new Uint8Array(Buffer.from(v.participantKeyHex['0']!, 'hex'));
    const cases = [
      ['admin', master],
      ['group', group],
      ['participant0', p0],
    ] as const;
    for (const [name, secret] of cases) {
      const token = await deriveToken(secret, v.tabId);
      expect(hex(token)).toBe(v.tokenHex[name]);
      expect(await hashToken(token)).toBe(v.tokenHashHex[name]);
    }
  });

  it('group mode yields admin and group tokens only', async () => {
    const { tokens } = await deriveTabKeys(master, v.tabId, 'group', 3);
    expect(hex(tokens.admin)).toBe(v.tokenHex.admin);
    expect(hex(tokens.group!)).toBe(v.tokenHex.group);
    expect(tokens.participants).toBeUndefined();
  });

  it('individual mode yields one token per participant and no group token', async () => {
    const { tokens } = await deriveTabKeys(master, v.tabId, 'individual', 3);
    expect(tokens.group).toBeUndefined();
    expect(tokens.participants).toHaveLength(3);
    expect(hex(tokens.participants![0]!)).toBe(v.tokenHex.participant0);
    expect(new Set(tokens.participants!.map(hex)).size).toBe(3);
  });

  it('encodeToken is 43 base64url characters', async () => {
    const s = encodeToken(await deriveToken(master, v.tabId));
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashToken is 64 lowercase hex characters', async () => {
    expect(await hashToken(await deriveToken(master, v.tabId))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tokens differ between tabs', async () => {
    expect(hex(await deriveToken(master, OTHER_TAB))).not.toBe(v.tokenHex.admin);
  });
});
