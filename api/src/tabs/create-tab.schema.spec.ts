import { randomBytes } from 'node:crypto';
import { createTabSchema } from './create-tab.schema.js';

const hex = () => randomBytes(32).toString('hex');
const blob = (n = 8) => randomBytes(n).toString('base64');

const group = () => ({
  mode: 'group',
  participants_count: 3,
  ufvk: 'uviewtest1abc',
  birthday: 3_000_000,
  blobs: { admin: blob(), group: blob() },
  token_hashes: { admin: hex(), group: hex() },
});

const individual = (count = 2) => ({
  mode: 'individual',
  participants_count: count,
  ufvk: 'uviewtest1abc',
  birthday: 3_000_000,
  blobs: {
    admin: blob(),
    participants: Array.from({ length: count }, () => blob()),
  },
  token_hashes: {
    admin: hex(),
    participants: Array.from({ length: count }, () => hex()),
  },
});

const test = createTabSchema('test');
const ok = (v: unknown) => expect(test.safeParse(v).success).toBe(true);
const bad = (v: unknown) => expect(test.safeParse(v).success).toBe(false);

describe('createTabSchema', () => {
  it('accepts a group tab', () => ok(group()));
  it('accepts an individual tab', () => ok(individual()));

  it('rejects participants_count 0', () => {
    bad({ ...group(), participants_count: 0 });
  });
  it('accepts participants_count 20 and rejects 21', () => {
    ok(individual(20));
    bad(individual(21));
  });
  it('rejects a non-integer participants_count', () => {
    bad({ ...group(), participants_count: 1.5 });
  });

  it('rejects an extra top-level field', () => {
    bad({ ...group(), extra: 1 });
  });
  it('rejects an extra field inside blobs', () => {
    const g = group();
    bad({ ...g, blobs: { ...g.blobs, other: blob() } });
  });

  it('rejects a blob that is not base64', () => {
    const g = group();
    bad({ ...g, blobs: { ...g.blobs, admin: 'not base64!!' } });
  });
  it('rejects an empty blob', () => {
    const g = group();
    bad({ ...g, blobs: { ...g.blobs, admin: '' } });
  });
  it('accepts a blob of exactly 16 KB and rejects 16 KB + 1', () => {
    const g = group();
    ok({ ...g, blobs: { ...g.blobs, admin: blob(16384) } });
    bad({ ...g, blobs: { ...g.blobs, admin: blob(16385) } });
  });

  it('rejects a token hash that is not 64 hex', () => {
    const g = group();
    bad({ ...g, token_hashes: { ...g.token_hashes, admin: 'ab'.repeat(31) } });
  });
  it('rejects an uppercase token hash', () => {
    const g = group();
    bad({
      ...g,
      token_hashes: { ...g.token_hashes, admin: hex().toUpperCase() },
    });
  });
  it('rejects duplicate token hashes within a request', () => {
    const g = group();
    bad({ ...g, token_hashes: { admin: g.token_hashes.admin, group: g.token_hashes.admin } });
  });

  it('group mode requires a group blob and hash', () => {
    const g = group();
    bad({ ...g, blobs: { admin: g.blobs.admin } });
    bad({ ...g, token_hashes: { admin: g.token_hashes.admin } });
  });
  it('group mode forbids participants', () => {
    const g = group();
    bad({ ...g, blobs: { ...g.blobs, participants: [blob()] } });
    bad({ ...g, token_hashes: { ...g.token_hashes, participants: [hex()] } });
  });

  it('individual mode requires participants matching participants_count', () => {
    const i = individual(2);
    bad({ ...i, blobs: { admin: i.blobs.admin } });
    bad({ ...i, blobs: { ...i.blobs, participants: [blob()] } });
    bad({
      ...i,
      token_hashes: { ...i.token_hashes, participants: [hex()] },
    });
  });
  it('individual mode forbids group', () => {
    const i = individual();
    bad({ ...i, blobs: { ...i.blobs, group: blob() } });
    bad({ ...i, token_hashes: { ...i.token_hashes, group: hex() } });
  });

  it('requires the UFVK prefix of the configured network', () => {
    bad({ ...group(), ufvk: 'uview1abc' });
    ok({ ...group(), ufvk: 'uviewtest1abc' });
    const main = createTabSchema('main');
    expect(main.safeParse({ ...group(), ufvk: 'uview1abc' }).success).toBe(true);
    expect(main.safeParse({ ...group(), ufvk: 'uviewtest1abc' }).success).toBe(
      false,
    );
  });

  it('rejects a negative or non-integer birthday', () => {
    bad({ ...group(), birthday: -1 });
    bad({ ...group(), birthday: 1.5 });
  });
  it('rejects an unknown mode', () => {
    bad({ ...group(), mode: 'other' });
  });
});
