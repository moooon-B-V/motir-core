import { db, dbPool } from '@/lib/db';

// Data access for the DATABASE CONNECTION itself, not for any table (Bug
// MOTIR-8231). The readiness warm-up (`readinessService`) is the only caller: it
// opens connections before a freshly started machine takes traffic, and reads
// back how many the pool holds open.
//
// ⚠️ NEITHER METHOD TOUCHES A TABLE, SO NEITHER NEEDS A BOUND CONTEXT. `SELECT 1`
// reads no row any RLS policy could gate, and the pool count is a property of
// this process. That is also why the warm-up can run before anyone has signed
// in, on a request that carries no credentials.

export const databaseConnectionRepository = {
  /** One round trip on one pooled connection — a READ that touches no table. */
  async ping(): Promise<void> {
    await db.$queryRaw`SELECT 1`;
  },

  /**
   * How many connections the pool behind `db` holds OPEN right now (`pg.Pool`'s
   * `totalCount`: idle plus checked out), or null when this module instance
   * does not own its pool (a client planted on `globalThis`, see `lib/db.ts`).
   *
   * ⚠️ IT IS THIS MODULE INSTANCE'S POOL. The Next server evaluates `lib/db.ts`
   * once per Turbopack runtime, so a route handler reads the route-handler
   * runtime's pool — the one `POST /api/github/webhook` transacts on — and a
   * page reads another.
   */
  openConnections(): number | null {
    return dbPool()?.totalCount ?? null;
  },
};
