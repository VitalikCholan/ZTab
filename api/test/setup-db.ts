import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { TEST_DATABASE_URL } from './test-env.js';

// Migrations are applied once per run by test/global-setup.ts
// (`prisma migrate deploy`); helpers here reset data between tests.

/** Empties every table; call between tests. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "tab_tokens", "tab_blobs", "tab_addresses", "tabs" RESTART IDENTITY CASCADE',
  );
}

export function newTestPrisma(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: TEST_DATABASE_URL }),
  });
}
