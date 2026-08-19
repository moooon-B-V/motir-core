import { db } from '@/lib/db';

// The CONNECTION-POOL warm-up every real-concurrency test needs (MOTIR-2961).
//
// A race test that opens its racers against a COLD pool is not a race test: the
// pool hands out one physical connection, the transactions serialise on it, and
// the assertion passes whether or not the lock under test exists. Forcing ≥ n
// connections open first is what makes the DATABASE's serialisation — the row
// lock — the only thing separating the callers.
//
// ⚠️ It lives here rather than being copied per suite for a reason the RLS
// ratchet makes concrete: `tests/rls/test-singleton-statement-guard.test.ts`
// counts every `$queryRaw` on the `@/lib/db` singleton under `tests/` and that
// ceiling only ever FALLS. A warm-up is legitimately a raw statement — it must
// touch the wire and it deliberately reads nothing — so the way to add a second
// concurrency suite without raising the count is to have one statement, here,
// that both of them call.

/**
 * Open at least `n` physical connections before a concurrency test runs.
 *
 * `SELECT 1` rather than a model read on purpose: it is the cheapest thing that
 * forces a real connection, it names no table, and it therefore has no RLS
 * behaviour for a reader to mistake for the thing under test.
 */
export async function warmPool(n = 6): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db.$queryRaw`SELECT 1`));
}
