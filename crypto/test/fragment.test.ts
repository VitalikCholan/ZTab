import { describe, expect, it } from 'vitest';
import { CryptoError, encodeFragment, fromBase64Url, parseFragment, toBase64Url } from '../src/index.ts';

const bytes = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

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
    expect(parseFragment(encodeFragment({ kind: 'group', key: bytes }))).toEqual({ kind: 'group', key: bytes });
    expect(parseFragment(encodeFragment({ kind: 'participant', index: 7, key: bytes }))).toEqual({ kind: 'participant', index: 7, key: bytes });
  });

  it('refuses to encode a bad key length or participant index as internal', () => {
    expect(codeOf(() => encodeFragment({ kind: 'admin', master: bytes.slice(0, 31) }))).toBe('internal');
    expect(codeOf(() => encodeFragment({ kind: 'group', key: new Uint8Array(33) }))).toBe('internal');
    for (const index of [-1, 1.5, 0x1_0000_0000, NaN]) {
      expect(codeOf(() => encodeFragment({ kind: 'participant', index, key: bytes }))).toBe('internal');
    }
    expect(encodeFragment({ kind: 'participant', index: 0xffff_ffff, key: bytes }).startsWith('#p=4294967295.')).toBe(true);
  });

  it('rejects malformed fragments as invalid_fragment', () => {
    const b64 = toBase64Url(bytes);
    for (const bad of ['', '#', '#x=' + b64, '#a=' + b64 + '=', '#a=' + b64.slice(0, 40), '#a=ab+c' + b64.slice(4), '#p=' + b64, '#p=07.' + b64, '#p=-1.' + b64, '#p=4294967296.' + b64, '#p=1.' + b64.slice(0, 10)]) {
      expect(codeOf(() => parseFragment(bad)), bad).toBe('invalid_fragment');
    }
  });
});
