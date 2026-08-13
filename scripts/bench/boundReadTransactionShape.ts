/**
 * The MEASUREMENT behind `docs/decisions/bound-read-transaction-shape.md`
 * (MOTIR-2799).
 *
 * `app.workspace_id` is bound with `set_config(…, true)`, which is
 * TRANSACTION-local, so every read MOTIR-2796 binds has to run inside a
 * transaction. A service method with N reads then has two shapes, and the whole
 * story ships whichever this script says is cheaper:
 *
 *   (A) ONE transaction per SERVICE METHOD — `withWorkspaceServiceContext` once,
 *       `tx` threaded into all N reads. Prisma serialises an interactive
 *       transaction onto ONE connection, so an existing `Promise.all` of N reads
 *       becomes N SEQUENTIAL reads.
 *   (B) ONE transaction per READ — N separate contexts, `Promise.all` still
 *       parallelises, at the cost of N pooled connections per request.
 *
 * ⚠️ WHY IT REPLAYS CAPTURED SQL RATHER THAN CALLING THE REPOSITORIES.
 * At the commit this script was written the eight `reportsService` reads take no
 * `tx` parameter — that is the very defect MOTIR-2796 fixes — so shape (A) cannot
 * be expressed through them. Copying their SQL into this file would measure a
 * COPY, and a copy drifts. So the script instead installs a query-logging
 * `PrismaClient` as the `@/lib/db` singleton BEFORE the repositories are imported,
 * calls each real repository method once, and CAPTURES the exact SQL text and
 * bind parameters Prisma sent. Every timed run replays those captured statements.
 * The statements are therefore the shipped ones by construction, and the capture
 * re-runs on every invocation — there is nothing to keep in sync.
 *
 * WHAT IT MEASURES, per iteration:
 *   • `unbound-parallel`  — today's behaviour: `Promise.all` on the singleton, no
 *                           transaction, no GUC. The baseline the two shapes are
 *                           regressions against, not a candidate (it is the bug).
 *   • `A-one-tx`          — one bound transaction, the 8 statements sequentially.
 *   • `B-tx-per-read`     — 8 bound transactions in `Promise.all`.
 *   • `tx-overhead`       — BEGIN + set_config + `SELECT 1` + COMMIT, so the
 *                           per-transaction cost is attributable rather than
 *                           inferred.
 *
 * It also reports the SEQUENTIAL-UNBOUND total, because the difference between
 * (A) and unbound-sequential is exactly the transaction overhead, while the
 * difference between (A) and unbound-parallel is the cost of losing concurrency.
 * Conflating those two is how this decision gets made on the wrong number.
 *
 * USAGE
 *   pnpm db:seed:reporting          # the 10 000-item corpus this reads
 *   pnpm bench:bound-read-shape     # ~30 s
 *
 * Environment:
 *   BENCH_ITERATIONS  (default 15)  timed repetitions after the warm-up
 *   BENCH_WARMUP      (default 3)   untimed repetitions, so the plan cache and
 *                                   the connection pool are warm for all shapes
 */
/* eslint-disable no-console -- a CLI bench script: console IS its output surface */
import './../_loadEnv'; // MUST be first — populates DATABASE_URL before @/lib/db loads
import { PrismaClient, type Prisma } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// ── The captured-statement plumbing ────────────────────────────────────────────

interface CapturedStatement {
  readonly label: string;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** A Prisma `query` log event — the shape the client emits with `emit: 'event'`. */
interface QueryEvent {
  query: string;
  params: string;
}

const captured: Array<{ sql: string; params: readonly unknown[] }> = [];

/**
 * Install a query-logging client as the `@/lib/db` singleton.
 *
 * `lib/db.ts` reads `globalThis.prisma` first and only constructs its own client
 * when that is empty, so seeding it here — before the first import of the module
 * — makes every repository call in this process go through a client we can
 * listen to. The connection string is the same one `lib/db.ts` would have used.
 */
function installLoggingClient(): PrismaClient {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set.');
  const client = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
    log: [{ emit: 'event', level: 'query' }],
  });
  (client as unknown as { $on: (e: 'query', cb: (ev: QueryEvent) => void) => void }).$on(
    'query',
    (ev) => {
      // BEGIN / COMMIT and the `set_config` GUC binding are not reads. A real
      // read starts `SELECT` or `WITH` (four of the eight are CTEs).
      const sql = ev.query.trim();
      if (!/^(SELECT|WITH)\b/i.test(sql)) return;
      if (/set_config\(/i.test(sql)) return;
      captured.push({ sql, params: JSON.parse(ev.params || '[]') as unknown[] });
    },
  );
  (globalThis as unknown as { prisma?: PrismaClient }).prisma = client;
  return client;
}

/** Run `fn` and return every SELECT it issued, labelled. */
async function capture(label: string, fn: () => Promise<unknown>): Promise<CapturedStatement[]> {
  captured.length = 0;
  await fn();
  // Prisma emits the log event asynchronously; yield until it has landed.
  for (let i = 0; i < 50 && captured.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  if (captured.length === 0) throw new Error(`captured no SQL for ${label}`);
  return captured.map((c, i) => ({
    label: captured.length === 1 ? label : `${label}#${i + 1}`,
    sql: c.sql,
    params: c.params,
  }));
}

// ── Timing ─────────────────────────────────────────────────────────────────────

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

function summarise(name: string, samples: readonly number[]) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    shape: name,
    n: s.length,
    p50: Number(percentile(s, 50).toFixed(1)),
    p95: Number(percentile(s, 95).toFixed(1)),
    min: Number((s[0] ?? 0).toFixed(1)),
    max: Number((s[s.length - 1] ?? 0).toFixed(1)),
    mean: Number((s.reduce((a, b) => a + b, 0) / (s.length || 1)).toFixed(1)),
  };
}

async function timeIt(fn: () => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const ITERATIONS = Number(process.env['BENCH_ITERATIONS'] ?? 15);
  const WARMUP = Number(process.env['BENCH_WARMUP'] ?? 3);

  const client = installLoggingClient();

  // Imported AFTER the singleton is installed — these modules resolve `db` at
  // module-eval, so the order is load-bearing.
  const { workItemRepository } = await import('@/lib/repositories/workItemRepository');
  const { workItemRevisionRepository } =
    await import('@/lib/repositories/workItemRevisionRepository');
  const { withWorkspaceServiceContext } = await import('@/lib/workspaces/context');
  const { bucketAxis, bucketEnds, reportWindow } = await import('@/lib/reports/buckets');
  const { SEED_REPORTING_PROJECT_IDENTIFIER } = await import('./../seedReportingFixture');

  // The corpus, located by the seed's own identifier — never by a hard-coded id.
  const project = await client.project.findFirst({
    where: { identifier: SEED_REPORTING_PROJECT_IDENTIFIER },
    select: { id: true, workspaceId: true },
  });
  if (!project) {
    throw new Error(
      `No project "${SEED_REPORTING_PROJECT_IDENTIFIER}" — run \`pnpm db:seed:reporting\` first.`,
    );
  }
  const sprint = await client.sprint.findFirst({
    where: { projectId: project.id },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
  const itemCount = await client.workItem.count({ where: { projectId: project.id } });
  const revisionCount = await client.workItemRevision.count({
    where: { workItem: { projectId: project.id } },
  });

  const { id: projectId, workspaceId } = project;
  const sprintId = sprint?.id ?? '';
  const period = 'week' as const;
  const daysBack = 180;
  const { start, end } = reportWindow(new Date(), daysBack);
  const axis = bucketAxis(period, start, end);
  const ends = bucketEnds(period, axis, end);
  const ageBuckets = axis.map((key, i) => ({ key, end: ends[i]! }));

  // ── Capture the eight statements from the real repository methods ────────────
  const statements: CapturedStatement[] = [
    ...(await capture('aggregateCreatedByBucket', () =>
      workItemRepository.aggregateCreatedByBucket(projectId, workspaceId, period, { start, end }),
    )),
    ...(await capture('aggregateDistribution', () =>
      workItemRepository.aggregateDistribution(projectId, workspaceId, {
        kind: 'column',
        column: 'status',
      }),
    )),
    ...(await capture('aggregateWorkloadByAssignee', () =>
      workItemRepository.aggregateWorkloadByAssignee(projectId, workspaceId),
    )),
    ...(await capture('sumStartedForSprint', () =>
      workItemRepository.sumStartedForSprint(sprintId, workspaceId, 'story_points'),
    )),
    ...(await capture('aggregateAverageAgeByBucket', () =>
      workItemRevisionRepository.aggregateAverageAgeByBucket(projectId, workspaceId, ageBuckets),
    )),
    ...(await capture('aggregateNetResolvedByBucket', () =>
      workItemRevisionRepository.aggregateNetResolvedByBucket(projectId, workspaceId, period, {
        start,
        end,
      }),
    )),
    ...(await capture('aggregateResolutionTimeByBucket', () =>
      workItemRevisionRepository.aggregateResolutionTimeByBucket(projectId, workspaceId, period, {
        start,
        end,
      }),
    )),
    ...(await capture('aggregateSprintCycleByDay', () =>
      workItemRevisionRepository.aggregateSprintCycleByDay(
        sprintId,
        workspaceId,
        { start, end },
        false,
      ),
    )),
  ];

  type AnyClient = Pick<PrismaClient, '$queryRawUnsafe'> | Prisma.TransactionClient;
  const run = (c: AnyClient, s: CapturedStatement) =>
    (c as { $queryRawUnsafe: (q: string, ...p: unknown[]) => Promise<unknown> }).$queryRawUnsafe(
      s.sql,
      ...s.params,
    );

  // Prove the replay works before timing it — a statement that errors would
  // otherwise show up as a suspiciously fast shape.
  for (const s of statements) {
    try {
      await run(client, s);
    } catch (err) {
      throw new Error(`replay of ${s.label} failed: ${(err as Error).message}`);
    }
  }

  // ── The four shapes ──────────────────────────────────────────────────────────
  const unboundParallel = () => Promise.all(statements.map((s) => run(client, s)));
  const unboundSequential = async () => {
    for (const s of statements) await run(client, s);
  };
  const shapeA = () =>
    withWorkspaceServiceContext(workspaceId, async (tx) => {
      for (const s of statements) await run(tx, s);
    });
  const shapeB = () =>
    Promise.all(
      statements.map((s) => withWorkspaceServiceContext(workspaceId, (tx) => run(tx, s))),
    );
  const txOverhead = () => withWorkspaceServiceContext(workspaceId, (tx) => tx.$queryRaw`SELECT 1`);

  const shapes: Array<[string, () => Promise<unknown>]> = [
    ['unbound-parallel (today, broken under motir_app)', unboundParallel],
    ['unbound-sequential', unboundSequential],
    ['A-one-tx-sequential', shapeA],
    ['B-tx-per-read-parallel', shapeB],
    ['tx-overhead (BEGIN+set_config+SELECT 1+COMMIT)', txOverhead],
  ];

  for (let i = 0; i < WARMUP; i++) for (const [, fn] of shapes) await fn();

  const results: Array<ReturnType<typeof summarise>> = [];
  for (const [name, fn] of shapes) {
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) samples.push(await timeIt(fn));
    results.push(summarise(name, samples));
  }

  // Per-statement timings, so the shape numbers can be reconciled against the
  // reads that produce them (an 8-wide parallel shape is bounded by its slowest).
  const perStatement: Array<{ statement: string; p50: number }> = [];
  for (const s of statements) {
    const samples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) samples.push(await timeIt(() => run(client, s)));
    perStatement.push({ statement: s.label, p50: summarise(s.label, samples).p50 });
  }

  // ── The velocity fan-out — the WIDEST fan-out the shipped file actually has ──
  //
  // The card that commissioned this bench describes `reportsService` as holding
  // an "8-wide fan-out". It does not: the eight aggregates sit in eight SEPARATE
  // report methods, and the file's real `Promise.all`s are `getCreatedVsResolved`
  // (2 reads) and `getVelocity` — a rollup PER completed sprint, default 7 and
  // capped at 52. That loop is where shape (A) genuinely serialises something
  // wide, so it is measured on its own rather than assumed to be covered by the
  // synthetic eight above.
  const rollupStatements = await capture('sumPointsForSprint', () =>
    workItemRepository.sumPointsForSprint(sprintId, workspaceId, 'story_points'),
  );
  const velocity = async (width: number, shape: 'A' | 'B') => {
    const reads = Array.from({ length: width }, () => rollupStatements).flat();
    if (shape === 'A') {
      return withWorkspaceServiceContext(workspaceId, async (tx) => {
        for (const s of reads) await run(tx, s);
      });
    }
    return Promise.all(
      reads.map((s) => withWorkspaceServiceContext(workspaceId, (tx) => run(tx, s))),
    );
  };
  const velocityMs: Array<{ width: number; shape: string; p50: number }> = [];
  for (const width of [7, 52]) {
    for (const shape of ['A', 'B'] as const) {
      const samples: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) samples.push(await timeIt(() => velocity(width, shape)));
      velocityMs.push({
        width,
        shape: shape === 'A' ? 'A-one-tx-sequential' : 'B-tx-per-read-parallel',
        p50: summarise('v', samples).p50,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        corpus: {
          projectIdentifier: SEED_REPORTING_PROJECT_IDENTIFIER,
          workItems: itemCount,
          workItemRevisions: revisionCount,
          reportWindowDays: daysBack,
          buckets: axis.length,
        },
        statements: statements.length,
        iterations: ITERATIONS,
        shapesMs: results,
        perStatementMs: perStatement,
        velocityFanOutMs: velocityMs,
      },
      null,
      2,
    ),
  );

  await client.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
