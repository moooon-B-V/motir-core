import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MigrateOnboardingStep } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import {
  migrateOnboardingSweep,
  MIGRATE_ONBOARDING_SWEEP_CRON,
} from '@/lib/jobs/definitions/migrateOnboardingSweep';
import { jobFunctions } from '@/lib/jobs/registry';
import { jobSchedules } from '@/lib/jobs/schedules';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';

// THE MIGRATE-ONBOARDING INDEX SWEEP (MOTIR-2082) — against a REAL Postgres (the
// motir-core convention). Nothing is mocked: the cross-workspace scan, the RLS
// policy's system-admin branch, the job-ledger read, the row lock and the
// re-assert under it are all the production paths.
//
// THE BUG IT FIXES. A migrate run's steps only advance when something CALLS a
// transition, and the only callers are the wizard client and its `index-status`
// poll — both in the browser. The `index` step is the slow one, so a user who
// closes the tab before the code-graph index finishes leaves the run `active` at
// `index` forever: the exit condition flips true later with nobody listening.
// The live MOTIR run sat there for fourteen days.
//
// What these lock:
//   * the REPAIR — a wedged run whose repo has a succeeded index advances to
//     `import`, persisting `codeGraphReady`;
//   * WHERE IT STOPS — `index → import` and no further, and NEVER `importSkipped`
//     (skipping the import is a user-owned product decision, not a job's);
//   * WHAT IT LEAVES ALONE — other steps, non-`active` runs, runs with no
//     succeeded index row, and runs with no connected repo at all;
//   * TENANCY — a succeeded index in ANOTHER workspace does not advance a run;
//   * IDEMPOTENCE — a second tick over already-repaired state is a no-op;
//   * CONCURRENCY — the row lock + the re-assert under it, driven by HOLDING the
//     lock from the test body (never `Promise.all` + hope), and mutation-checked:
//     the closing test's own comment records what reddens when `lockById` goes.

/** Seed a migrate run directly at a given step/status — the wedged-state fixture
 *  (the repository reach is allowed for tests). */
async function seedRun(
  fx: WorkItemFixture,
  data: {
    step: MigrateOnboardingStep;
    status?: 'active' | 'completed' | 'failed';
    connectedRepoRef?: string | null;
    codeGraphReady?: boolean;
  },
) {
  return db.migrateOnboarding.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      kind: 'migrate',
      step: data.step,
      status: data.status ?? 'active',
      connectedRepoRef: data.connectedRepoRef ?? null,
      codeGraphReady: data.codeGraphReady ?? false,
    },
  });
}

/** Seed a SUCCEEDED `system.code-graph-index` ledger row for a repo — the exit
 *  signal the sweep reads. Mirrors what the real index job writes on success. */
async function seedSucceededIndexJob(workspaceId: string, repoRef: string) {
  await db.jobRun.create({
    data: {
      workspaceId,
      functionId: 'system.code-graph-index',
      eventName: 'system.code-graph-index',
      eventId: `evt-${randomToken()}`,
      attempt: 0,
      status: 'succeeded',
      finishedAt: new Date(),
      output: { indexed: true, repoRef, projectsIndexed: 1 },
    },
  });
}

async function readRun(id: string) {
  const row = await db.migrateOnboarding.findUniqueOrThrow({ where: { id } });
  return row;
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the index sweep repairs a wedged run', () => {
  it('advances an active run parked at index whose repo has a succeeded index', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'index', connectedRepoRef: 'acme/widgets' });
    await seedSucceededIndexJob(fx.workspaceId, 'acme/widgets');

    const summary = await migrateOnboardingService.runIndexSweep();

    expect(summary).toEqual({ scanned: 1, advanced: 1, failed: 0 });
    const after = await readRun(run.id);
    expect(after.step).toBe('import');
    expect(after.codeGraphReady).toBe(true);
    expect(after.status).toBe('active');
  });

  it('STOPS at import — it never skips the user-owned import decision', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'index', connectedRepoRef: 'acme/widgets' });
    await seedSucceededIndexJob(fx.workspaceId, 'acme/widgets');

    // Two ticks: the first advances to `import`, the second must find it there
    // and leave it — the run waits for a human, which is correct, not a wedge.
    await migrateOnboardingService.runIndexSweep();
    const second = await migrateOnboardingService.runIndexSweep();

    expect(second).toEqual({ scanned: 0, advanced: 0, failed: 0 });
    const after = await readRun(run.id);
    expect(after.step).toBe('import');
    expect(after.importSkipped).toBe(false);
    expect(after.importCompleted).toBe(false);
  });

  it('advances a run already flagged codeGraphReady but still parked at index', async () => {
    // The signal was observed and persisted, but the tab closed before the hop —
    // no ledger row needed, `codeGraphReady` alone satisfies INDEX's exit.
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, {
      step: 'index',
      connectedRepoRef: 'acme/widgets',
      codeGraphReady: true,
    });

    const summary = await migrateOnboardingService.runIndexSweep();

    expect(summary.advanced).toBe(1);
    expect((await readRun(run.id)).step).toBe('import');
  });
});

describe('the index sweep leaves everything else alone', () => {
  it('leaves a run at index whose repo has no succeeded index row', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'index', connectedRepoRef: 'acme/widgets' });
    // A RUNNING index is not a succeeded one.
    await db.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: 'evt-running',
        attempt: 0,
        status: 'running',
      },
    });

    const summary = await migrateOnboardingService.runIndexSweep();

    expect(summary).toEqual({ scanned: 1, advanced: 0, failed: 0 });
    const after = await readRun(run.id);
    expect(after.step).toBe('index');
    expect(after.codeGraphReady).toBe(false);
  });

  it('leaves a run at index with no connected repo at all', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'index', connectedRepoRef: null });
    await seedSucceededIndexJob(fx.workspaceId, 'acme/widgets');

    const summary = await migrateOnboardingService.runIndexSweep();

    expect(summary.advanced).toBe(0);
    expect((await readRun(run.id)).step).toBe('index');
  });

  it.each<MigrateOnboardingStep>(['import', 'audit_convention', 'discovery', 'generate', 'review'])(
    'never advances a run parked at %s',
    async (step) => {
      const fx = await makeWorkItemFixture();
      const run = await seedRun(fx, { step, connectedRepoRef: 'acme/widgets' });
      await seedSucceededIndexJob(fx.workspaceId, 'acme/widgets');

      const summary = await migrateOnboardingService.runIndexSweep();

      expect(summary).toEqual({ scanned: 0, advanced: 0, failed: 0 });
      expect((await readRun(run.id)).step).toBe(step);
    },
  );

  it.each(['completed', 'failed'] as const)(
    'never advances a %s run, even one sitting at index',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const run = await seedRun(fx, { step: 'index', status, connectedRepoRef: 'acme/widgets' });
      await seedSucceededIndexJob(fx.workspaceId, 'acme/widgets');

      const summary = await migrateOnboardingService.runIndexSweep();

      expect(summary).toEqual({ scanned: 0, advanced: 0, failed: 0 });
      expect((await readRun(run.id)).step).toBe('index');
    },
  );

  it('does not let one workspace’s succeeded index advance another’s run', async () => {
    // Same repo ref, two tenants: only the workspace that actually indexed it
    // advances. The `workspaceId` filter is what keeps the cross-tenant scan from
    // becoming a cross-tenant SIGNAL.
    const indexed = await makeWorkItemFixture({ name: 'Indexed', identifier: 'IDX' });
    const bare = await makeWorkItemFixture({ name: 'Bare', identifier: 'BARE' });
    const indexedRun = await seedRun(indexed, { step: 'index', connectedRepoRef: 'acme/widgets' });
    const bareRun = await seedRun(bare, { step: 'index', connectedRepoRef: 'acme/widgets' });
    await seedSucceededIndexJob(indexed.workspaceId, 'acme/widgets');

    const summary = await migrateOnboardingService.runIndexSweep();

    expect(summary).toEqual({ scanned: 2, advanced: 1, failed: 0 });
    expect((await readRun(indexedRun.id)).step).toBe('import');
    expect((await readRun(bareRun.id)).step).toBe('index');
  });
});

describe('the index sweep scans across workspaces, in bounded pages', () => {
  it('repairs wedged runs in several workspaces in one tick, paging through them', async () => {
    const fixtures = await Promise.all([
      makeWorkItemFixture({ name: 'W1', identifier: 'W1' }),
      makeWorkItemFixture({ name: 'W2', identifier: 'W2' }),
      makeWorkItemFixture({ name: 'W3', identifier: 'W3' }),
    ]);
    const runs = [];
    for (const fx of fixtures) {
      runs.push(await seedRun(fx, { step: 'index', connectedRepoRef: 'acme/widgets' }));
      await seedSucceededIndexJob(fx.workspaceId, 'acme/widgets');
    }

    // A page size smaller than the population forces the cursor path.
    const summary = await migrateOnboardingService.runIndexSweep({ pageSize: 2 });

    expect(summary).toEqual({ scanned: 3, advanced: 3, failed: 0 });
    for (const run of runs) {
      expect((await readRun(run.id)).step).toBe('import');
    }
  });
});

describe('the index sweep is concurrency-safe', () => {
  /**
   * Wait until some backend is actually WAITING on a lock. This is what makes the
   * interleaving DRIVEN rather than hoped for: if the sweep never blocks, this
   * throws and the test fails loudly instead of passing by accident.
   */
  async function waitForBlockedLock(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const rows = await db.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM pg_locks WHERE NOT granted
      `;
      if (Number(rows[0]!.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      'no backend ever blocked on the row lock — the race was not driven, so this test proves nothing',
    );
  }

  it('loses the race to a live wizard advance and NO-OPS instead of dragging the run backwards', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'index', connectedRepoRef: 'acme/widgets' });
    await seedSucceededIndexJob(fx.workspaceId, 'acme/widgets');

    // (1) The "wizard" takes the row lock and advances the run PAST import — the
    // user was there, saw the index finish, and chose to skip the import. Its
    // transaction stays open, holding the lock.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wizard = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "migrate_onboarding" WHERE "id" = ${run.id} FOR UPDATE`;
        await tx.migrateOnboarding.update({
          where: { id: run.id },
          data: { step: 'audit_convention', codeGraphReady: true, importSkipped: true },
        });
        await held;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );

    // (2) The sweep starts, finds the run at `index` (the wizard has not
    // committed, so its write is invisible), and blocks on the row lock.
    const sweep = migrateOnboardingService.runIndexSweep();
    await waitForBlockedLock();

    // (3) The wizard commits. The sweep now takes the lock, RE-READS, and sees
    // `audit_convention` — its re-assert fails and it no-ops.
    release();
    await wizard;
    const summary = await sweep;

    expect(summary).toEqual({ scanned: 1, advanced: 0, failed: 0 });

    // THE MUTATION CHECK. Delete the `lockById` call from `commitAdvance` and
    // this test reddens on BOTH assertions: without the lock the sweep re-reads
    // the stale pre-commit row (READ COMMITTED hides the wizard's uncommitted
    // write), passes its step re-assert against `index`, and writes `step:
    // 'import'` — reporting `advanced: 1` and dragging the run BACKWARDS over
    // the user's skip decision. The lock is what makes the re-read see reality.
    const after = await readRun(run.id);
    expect(after.step).toBe('audit_convention');
    expect(after.importSkipped).toBe(true);
  });
});

describe('the sweep lane is mounted', () => {
  it('is registered as an idempotent cron job on the schedule table and the serve route', () => {
    // Read the config off the BUILT function (`fn.opts`) — `defineJob`
    // translates `retryPolicy` into Inngest's `retries` before `createFunction`
    // ever sees it, so `retryPolicy` is not a key here and asserting it would
    // pass vacuously against `undefined`. `idempotent` = 5 attempts = 4 retries.
    //
    // The lane was RENAMED `system.migrate-index-sweep` →
    // `system.migrate-onboarding-sweep` when MOTIR-2092 added the terminal
    // reconciliation to it: the tick no longer only repairs the `index` step, and
    // a lane whose ledger id names one of its two jobs misleads whoever reads the
    // ledger to find out which one ran.
    const config = (migrateOnboardingSweep as unknown as { opts: Record<string, unknown> })
      .opts as {
      id: string;
      retries?: number;
      triggers?: Array<{ cron?: string }>;
    };
    expect(config.id).toBe('system.migrate-onboarding-sweep');
    expect(config.retries).toBe(4);
    expect(config.triggers?.[0]?.cron).toBe(MIGRATE_ONBOARDING_SWEEP_CRON);

    // Registered on the schedule table, so the MOTIR-1970 schedule-health check
    // can see it go quiet, AND mounted on the serve route's list — a lane the
    // registry never exports is a lane that never runs.
    expect(jobSchedules()).toContainEqual({
      functionId: 'system.migrate-onboarding-sweep',
      cron: MIGRATE_ONBOARDING_SWEEP_CRON,
    });
    expect(jobFunctions).toContain(migrateOnboardingSweep);
  });
});
