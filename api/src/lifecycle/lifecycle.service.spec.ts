import { jest } from '@jest/globals';
import { ApiError } from '../common/api-error.js';
import { LifecycleService } from './lifecycle.service.js';

function setup(setActive: (id: string, active: boolean) => Promise<void>, ids = ['t1']) {
  const deleteMany = jest.fn(async (args: { where: { id: { in: string[] } } }) => ({
    count: args.where.id.in.length,
  }));
  let served = false;
  const prisma = {
    tab: {
      findMany: async () => {
        if (served) return [];
        served = true;
        return ids.map((id) => ({ id }));
      },
      deleteMany,
    },
  };
  const calls: [string, boolean][] = [];
  const watcher = {
    setActive: async (id: string, active: boolean) => {
      calls.push([id, active]);
      await setActive(id, active);
    },
  };
  const service = new LifecycleService(prisma as never, watcher as never);
  return { service, deleteMany, calls };
}

const now = new Date('2026-10-25T00:00:00Z');

describe('LifecycleService.purgeInactive', () => {
  it('purge pauses the tab at the watcher before deleting it', async () => {
    const order: string[] = [];
    const { service, deleteMany } = setup(async () => {
      order.push('pause');
    });
    deleteMany.mockImplementation(async (args) => {
      order.push('delete');
      return { count: args.where.id.in.length };
    });
    expect(await service.purgeInactive(now)).toBe(1);
    expect(order).toEqual(['pause', 'delete']);
  });

  it('purge keeps the tab when the watcher is unreachable', async () => {
    const { service, deleteMany } = setup(async (id) => {
      if (id === 't1') throw new ApiError(503, 'watcher_unavailable', 'down');
    }, ['t1', 't2']);
    expect(await service.purgeInactive(now)).toBe(1);
    const deleted = deleteMany.mock.calls.flatMap((c) => c[0].where.id.in);
    expect(deleted).toEqual(['t2']);
  });

  it('purge treats watcher 404 as paused', async () => {
    const { service, deleteMany } = setup(async () => {
      throw new ApiError(404, 'watcher_rejected', 'tab not found');
    });
    expect(await service.purgeInactive(now)).toBe(1);
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });
});
