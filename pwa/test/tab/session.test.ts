import { createMaster, importBlobKey } from '@ztab/crypto';
import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/tab/keys.ts';
import { sessionStore } from '../../src/tab/session.ts';

describe('sessionStore', () => {
  it('set/get by tab id; clear forgets and zeroes the secrets', async () => {
    const s: Session = {
      tabId: 't1',
      role: 'admin',
      master: createMaster(),
      blobKey: await importBlobKey(createMaster()),
      token: createMaster(),
      fullUrl: 'https://ztab.example/t/t1#a=x',
    };
    expect(sessionStore.get('t1')).toBeUndefined();
    sessionStore.set(s);
    expect(sessionStore.get('t1')).toBe(s);
    sessionStore.clear('t1');
    expect(sessionStore.get('t1')).toBeUndefined();
    for (const b of [s.master!, s.token, s.blobKey.raw]) expect(b.every((x) => x === 0)).toBe(true);
  });
});
