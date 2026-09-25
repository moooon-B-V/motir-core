import { afterEach } from 'vitest';

/**
 * EVERY test ends with nothing of its own still running on the database
 * (MOTIR-6278) — a suite-wide `afterEach` that FAILS the test which left a
 * client backend `active` or `idle in transaction` on its worker's database,
 * naming the query.
 *
 * WHY IT FAILS RATHER THAN LOGS. Three times now (MOTIR-3066, MOTIR-6235,
 * MOTIR-6278) a refusal path returned while work it had started was still
 * holding a transaction, and three times the only detector was a LATER,
 * UNRELATED test's `truncateAuthTables` losing a `40P01` deadlock — which reds
 * whichever pull request happens to be running and starts the hunt from the
 * wrong file. The leak itself is deterministic in shape and only its victim is
 * random, so the check belongs at the leak: the test that started the work is
 * the one that has to wait for it. MOTIR-3077 built this probe OFF by default,
 * as a sweep instrument writing to stderr; a warning nobody reads found none of
 * the three.
 *
 * SCOPE — DB-BACKED FILES ONLY, decided per file by whether it ever opened a
 * Prisma client: `@/lib/db` stashes its singleton on `globalThis.prisma` and
 * `tests/helpers/adminDb.ts` on `globalThis.adminPrisma`. A file that has done
 * neither (a pure component or unit test) cannot have left a backend on the
 * database and pays nothing — the import below is dynamic so it does not even
 * construct the admin client.
 *
 * COST — one `pg_stat_activity` read per DB-backed test on the admin
 * connection. Measured in the PR that turned it on (MOTIR-6278).
 *
 * ORDER — this file is registered in `setupFiles`, so its `afterEach` is
 * registered before any test file's and, with Vitest's default
 * `sequence.hooks: 'stack'`, runs AFTER them. A file's own teardown (closing a
 * server, awaiting a drain) therefore happens first, and only work that
 * survives the file's own cleanup is reported.
 *
 * WHAT TO DO WHEN IT FIRES: find the promise the named query belongs to and
 * AWAIT it (or settle it — `Promise.allSettled` rather than a `Promise.all`
 * that rejects while its siblings are still running, which was the shape all
 * three times). Do not retry the reset, and do not widen this check to ignore
 * the query: the backend it names is holding locks after its caller moved on,
 * which is a production defect as well as a test one.
 */
afterEach(async () => {
  const opened = globalThis as unknown as { prisma?: unknown; adminPrisma?: unknown };
  if (!opened.prisma && !opened.adminPrisma) return;

  const { inFlightBackends, describeInFlight } = await import('./inFlightWork');
  let leftover;
  try {
    leftover = await inFlightBackends();
  } catch {
    // A file that opened a client but points it at no reachable database (a
    // test of the connection-failure path itself) has nothing to ask. That is
    // not a finding; a leak needs a database to leak onto.
    return;
  }
  if (leftover.length === 0) return;
  throw new Error(
    `This test ended with ${leftover.length} backend(s) of its own still working on the ` +
      `database. Await (or settle) the work that started them — a leftover like this is ` +
      `what deadlocks the NEXT test's reset (MOTIR-6278, tests/helpers/inFlightProbe.ts):\n` +
      describeInFlight(leftover),
  );
});
