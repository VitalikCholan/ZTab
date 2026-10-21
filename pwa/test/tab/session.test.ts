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

  it('set over another session of the same tab zeroes the replaced one', async () => {
    const mk = async (): Promise<Session> => ({
      tabId: 't2', role: 'admin', master: createMaster(), blobKey: await importBlobKey(createMaster()),
      token: createMaster(), fullUrl: 'https://ztab.example/t/t2#a=x',
    });
    const a = await mk();
    const b = await mk();
    sessionStore.set(a);
    sessionStore.set(a); // the same session again is not a replacement
    expect(a.token.some((x) => x !== 0)).toBe(true);
    sessionStore.set(b);
    expect(sessionStore.get('t2')).toBe(b);
    for (const x of [a.master!, a.token, a.blobKey.raw]) expect(x.every((v) => v === 0)).toBe(true);
    expect(b.token.some((x) => x !== 0)).toBe(true);
    sessionStore.clear('t2');
  });
});
