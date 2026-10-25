import { jest } from '@jest/globals';
import { ApiError } from '../common/api-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { hashToken } from '../auth/token.js';
import { TabsService } from './tabs.service.js';

describe('TabsService retry transaction', () => {
  it('maps a P2002 collision to 409 conflict', async () => {
    const admin = Buffer.alloc(32, 7);
    const hashHex = hashToken(admin).toString('hex');
    const existing = {
      id: 'tab-1',
      ufvk: 'uviewtest1x',
      mode: 'group',
      participantsCount: 1,
      birthday: 1,
      addresses: [{ index: 0, address: 'utest1a' }],
      tokens: [{ role: 'admin', index: null, tokenHash: hashToken(admin) }],
    };
    const prisma = {
      tab: { findUnique: async () => existing },
      tabBlob: { deleteMany: () => 'd', createMany: () => 'c' },
      $transaction: async () => {
        throw new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        });
      },
    };
    const service = new TabsService(prisma as never, {} as never, { network: 'test' } as never);
    const input = {
      mode: 'group',
      participants_count: 1,
      ufvk: 'uviewtest1x',
      birthday: 1,
      blobs: { admin: 'YQ==', group: 'Yg==' },
      token_hashes: { admin: hashHex, group: 'f'.repeat(64) },
    };
    // Stored tokens must equal the sent set: add the group row to the stored side.
    existing.tokens.push({ role: 'group', index: null, tokenHash: Buffer.from('f'.repeat(64), 'hex') });
    const err = await service
      .create('tab-1', input as never, `Bearer ${admin.toString('base64url')}`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
  });
});

describe('TabsService create compensation', () => {
  const input = {
    mode: 'group',
    participants_count: 1,
    ufvk: 'uviewtest1x',
    birthday: 1,
    blobs: { admin: 'YQ==', group: 'Yg==' },
    token_hashes: { admin: 'a'.repeat(64), group: 'f'.repeat(64) },
  };
  const registered = { addresses: [{ index: 0, address: 'utest1abc' }] };

  function build(opts: {
    register: () => Promise<unknown>;
    create?: () => Promise<unknown>;
    setActive?: () => Promise<void>;
  }) {
    const setActive = jest.fn(opts.setActive ?? (async () => undefined));
    const prisma = {
      tab: { findUnique: async () => null, create: opts.create ?? (async () => ({})) },
    };
    const watcher = { registerTab: opts.register, setActive };
    const service = new TabsService(prisma as never, watcher as never, { network: 'test' } as never);
    return { service, setActive };
  }

  it('create pauses the watcher tab when the DB insert fails', async () => {
    const { service, setActive } = build({
      register: async () => registered,
      create: async () => {
        throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' });
      },
      setActive: async () => {
        throw new ApiError(503, 'watcher_unavailable', 'down');
      },
    });
    const err = await service.create('Tab-1', input as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'conflict' });
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledWith('tab-1', false);
  });

  it('create pauses the watcher tab after a watcher timeout', async () => {
    const { service, setActive } = build({
      register: async () => {
        throw new ApiError(503, 'watcher_unavailable', 'timeout');
      },
      setActive: async () => {
        throw new ApiError(503, 'watcher_unavailable', 'still down');
      },
    });
    const err = await service.create('tab-1', input as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: 'watcher_unavailable', message: 'timeout' });
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledWith('tab-1', false);
  });

  it('create does not pause anything when the watcher refuses with a 4xx', async () => {
    const { service, setActive } = build({
      register: async () => {
        throw new ApiError(400, 'watcher_rejected', 'bad ufvk');
      },
    });
    await expect(service.create('tab-1', input as never)).rejects.toMatchObject({ status: 400 });
    expect(setActive).not.toHaveBeenCalled();
  });
});
