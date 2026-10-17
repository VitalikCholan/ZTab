import { createHash } from 'node:crypto';
import { hashToken, parseBearer } from './token.js';

const raw = Buffer.alloc(32, 7);
const b64u = raw.toString('base64url');

describe('parseBearer', () => {
  it('accepts a 32-byte base64url token', () => {
    expect(parseBearer(`Bearer ${b64u}`)?.equals(raw)).toBe(true);
  });

  it('rejects a missing header', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('')).toBeNull();
  });

  it('rejects base64 padding and the standard alphabet', () => {
    expect(parseBearer(`Bearer ${b64u}=`)).toBeNull();
    const std = Buffer.alloc(32, 0xfb).toString('base64');
    expect(std).toMatch(/[+/]/);
    expect(parseBearer(`Bearer ${std}`)).toBeNull();
  });

  it('rejects tokens that are not exactly 32 bytes', () => {
    expect(parseBearer(`Bearer ${Buffer.alloc(31).toString('base64url')}`)).toBeNull();
    expect(parseBearer(`Bearer ${Buffer.alloc(33).toString('base64url')}`)).toBeNull();
  });

  it('rejects a wrong scheme or extra parts', () => {
    expect(parseBearer(`Basic ${b64u}`)).toBeNull();
    expect(parseBearer(`bearer ${b64u}`)).toBeNull();
    expect(parseBearer(b64u)).toBeNull();
    expect(parseBearer(`Bearer ${b64u} x`)).toBeNull();
  });
});

describe('hashToken', () => {
  it('is SHA-256 of the token bytes', () => {
    expect(hashToken(raw).equals(createHash('sha256').update(raw).digest())).toBe(true);
    expect(hashToken(raw)).toHaveLength(32);
  });
});
