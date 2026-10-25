import { describe, expect, it } from 'vitest';
import { COMMIT_BYTES, blobCommit } from '../src/index.ts';

describe('blobCommit', () => {
  it('is 16 bytes', async () => {
    expect(COMMIT_BYTES).toBe(16);
    expect((await blobCommit({ a: 1 })).length).toBe(16);
  });

  it('is stable across key order and unicode', async () => {
    const x = await blobCommit({ b: 1, a: 'Café "x" 🍕' });
    const y = await blobCommit({ a: 'Café "x" 🍕', b: 1 });
    expect(x).toEqual(y);
  });

  it('is stable across nested key order and keeps array order', async () => {
    expect(await blobCommit({ l: [{ y: 1, x: 2 }] })).toEqual(await blobCommit({ l: [{ x: 2, y: 1 }] }));
    expect(await blobCommit([1, 2])).not.toEqual(await blobCommit([2, 1]));
  });

  it('differs when an address changes', async () => {
    const a = await blobCommit({ addr: 'utest1aaa', n: 1 });
    const b = await blobCommit({ addr: 'utest1aab', n: 1 });
    expect(a).not.toEqual(b);
  });
});
