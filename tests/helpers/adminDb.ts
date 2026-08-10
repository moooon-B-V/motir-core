import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { currentWorkerAdminUrl } from './parallelDb';

/**
 * The ADMIN half of the two-client test model (MOTIR-2513).
 *
 * `@/lib/db` is the CODE UNDER TEST's connection: under `TEST_DB_APP_ROLE=1` it
 * is the non-bypass runtime role, so the workspace RLS policies execute against
 * every query a service or repository makes — which is the whole point of the
 * flag. This client is the other side: the database OWNER, used by fixtures,
 * teardown and any direct-DB assertion.
 *
 * The split is not a convenience. Test setup legitimately needs two things the
 * runtime role must never have:
 *
 *   * `TRUNCATE`, which requires table OWNERSHIP. `tests/helpers/db.ts` resets
 *     between tests with `TRUNCATE … CASCADE`; granting that to the runtime role
 *     to make the suite pass would hand production code the ability to empty a
 *     table, which is a far worse trade than a second client.
 *   * CROSS-TENANT writes. A two-tenant fixture has to create rows in both
 *     tenants — precisely what the policies exist to refuse. Seeding through the
 *     app role would either fail or force the fixture to bind a context per
 *     tenant, turning setup into the thing under test.
 *
 * It is a SEPARATE PrismaClient rather than a mode on the singleton because
 * `lib/db.ts` reads `DATABASE_URL` once at module evaluation; one process cannot
 * hold two roles on one client.
 *
 * Stashed on `globalThis` for the same reason `lib/db.ts` does it — a worker runs
 * many test files and each would otherwise open its own pool.
 *
 * ⚠️ Use this for SETUP and TEARDOWN, never to exercise the behaviour under test.
 * An assertion made through this client is made as a role that bypasses nothing
 * but is subject to nothing either, so it proves the row exists — not that the
 * application could see it.
 */
const globalForAdminDb = globalThis as unknown as { adminPrisma?: PrismaClient };

function createAdminClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: currentWorkerAdminUrl() }),
  });
}

export const adminDb = globalForAdminDb.adminPrisma ?? createAdminClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalForAdminDb.adminPrisma = adminDb;
}
