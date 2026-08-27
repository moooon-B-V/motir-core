import { type Prisma } from '@/generated/prisma/client';

/**
 * The database's own reachability — the operator console's "Database" signal
 * (MOTIR-1167, design `platform-admin/design-notes.md` Panel 8).
 *
 * A repository with one method and no entity, which is unusual enough to
 * justify: the thing being read IS the connection, and `CLAUDE.md`'s rule that
 * only repositories touch Prisma applies to a `SELECT 1` exactly as it does to a
 * `findMany`. The alternative — a `db.$queryRaw` inlined in the service — is the
 * shape the 4-layer rule names first among its Don'ts.
 *
 * ⚠️ `SELECT 1` AND NOTHING ELSE. A ping that reads a real table measures that
 * table's policies, its indexes and its size as well as the connection, so a
 * slow query would render as a sick database and an RLS denial as an outage. The
 * card says "reachable", so the probe must ask nothing else.
 */
export const databaseHealthRepository = {
  /** Issue the cheapest possible statement. Throws if the connection is gone. */
  async ping(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$queryRaw`SELECT 1`;
  },
};
