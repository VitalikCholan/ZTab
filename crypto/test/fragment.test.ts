import { describe, expect, it } from 'vitest';
import { CryptoError, encodeFragment, fromBase64Url, parseFragment, toBase64Url } from '../src/index.ts';

const bytes = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const commit = Uint8Array.from({ length: 16 }, (_, i) => i * 3);

function codeOf(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(CryptoError);
    return (e as CryptoError).code;
  }
  throw new Error('did not throw');
}

describe('base64url', () => {
  it('round-trips without padding or +/', () => {
    const text = toBase64Url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(text).not.toContain('=');
    expect(fromBase64Url(text)).toEqual(bytes);
    expect(fromBase64Url('')).toEqual(new Uint8Array(0));
  });

  it('returns null for padding, +/ and impossible lengths', () => {
    expect(fromBase64Url(toBase64Url(bytes) + '=')).toBeNull();
    expect(fromBase64Url('ab+c')).toBeNull();
    expect(fromBase64Url('a')).toBeNull();
  });
});

describe('fragments', () => {
  it('encodes and parses the three link forms', () => {
    const admin = encodeFragment({ kind: 'admin', master: bytes });
    expect(admin.startsWith('#a=')).toBe(true);
    expect(parseFragment(admin)).toEqual({ kind: 'admin', master: bytes });
    expect(parseFragment(admin.slice(1))).toEqual({ kind: 'admin', master: bytes });
    expect(parseFragment(encodeFragment({ kind: 'group', key: bytes, commit }))).toEqual({ kind: 'group', key: bytes, commit });
    expect(parseFragment(encodeFragment({ kind: 'participant', index: 7, key: bytes, commit }))).toEqual({ kind: 'participant', index: 7, key: bytes, commit });
  });

  it('refuses to encode a bad key length or participant index as internal', () => {
    expect(codeOf(() => encodeFragment({ kind: 'admin', master: bytes.slice(0, 31) }))).toBe('internal');
    expect(codeOf(() => encodeFragment({ kind: 'group', key: new Uint8Array(33), commit }))).toBe('internal');
    for (const len of [0, 15, 17]) {
      expect(codeOf(() => encodeFragment({ kind: 'group', key: bytes, commit: new Uint8Array(len) }))).toBe('internal');
      expect(codeOf(() => encodeFragment({ kind: 'participant', index: 0, key: bytes, commit: new Uint8Array(len) }))).toBe('internal');
    }
    for (const index of [-1, 1.5, 0x1_0000_0000, NaN]) {
      expect(codeOf(() => encodeFragment({ kind: 'participant', index, key: bytes, commit }))).toBe('internal');
    }
    expect(encodeFragment({ kind: 'participant', index: 0xffff_ffff, key: bytes, commit }).startsWith('#p=4294967295.')).toBe(true);
  });

  it('rejects malformed fragments as invalid_fragment', () => {
    const b64 = toBase64Url(bytes);
    const c64 = toBase64Url(commit);
    const bads = [
      '', '#', '#x=' + b64, '#a=' + b64 + '=', '#a=' + b64.slice(0, 40), '#a=ab+c' + b64.slice(4),
      '#g=' + b64, '#p=0.' + b64, '#g=' + b64 + '.' + toBase64Url(commit.slice(0, 15)), '#g=' + b64 + '.' + toBase64Url(new Uint8Array(17)),
      '#p=0.' + b64 + '.' + toBase64Url(commit.slice(0, 15)), '#p=0.' + b64 + '.' + toBase64Url(new Uint8Array(17)),
      '#p=' + b64 + '.' + c64, '#p=07.' + b64 + '.' + c64, '#p=-1.' + b64 + '.' + c64, '#p=4294967296.' + b64 + '.' + c64, '#p=1.' + b64.slice(0, 10) + '.' + c64,
    ];
    for (const bad of bads) {
      expect(codeOf(() => parseFragment(bad)), bad).toBe('invalid_fragment');
    }
  });
});
