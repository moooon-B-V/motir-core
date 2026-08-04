import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MigrateOnboardingStep } from '@prisma/client';
import { db } from '@/lib/db';
import { migrateOnboardingService } from '@/lib/services/migrateOnboardingService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// THE MIGRATE-ONBOARDING TERMINAL RECONCILIATION (MOTIR-2092) — against a REAL
// Postgres (the motir-core convention). Nothing is mocked: the cross-workspace
// scan, the RLS policy's system-admin branch on BOTH tables, the row lock and
// the re-assert under it are all the production paths.
//
// THE BUG IT FIXES. `migrate_onboarding` reaches `completed` in exactly one
// place — the terminal `review → done` hop, whose only callers are the wizard
// client in a browser tab. But "onboarding is over" has a SECOND, durable
// writer the run never reads: `project.onboardingRanAt`. So there are two
// producers of a permanently-`active` run on a permanently-established project:
//
//   1. THE APPROVE RACE — `approvePlan` stamps the marker in the approve's own
//      transaction, then the client is expected to come back for the last hop.
//      Close the tab in between and it never does.
//   2. THE MARKER'S OTHER WRITERS — the dogfood seed and the MOTIR-1799 operator
//      stamp write it with no wizard interaction at all, orphaning the run
//      wherever it happened to be. The live `MOTIR` row is this case exactly:
//      marker stamped 2026-08-04T16:33Z, run `active` at `index`.
//
// What these lock:
//   * BOTH PRODUCERS — a run at `review` (the race) and a run at `index` (the
//     live MOTIR shape) both terminate, and so does every step in between;
//   * WHERE IT LANDS — `step: 'done'` + `status: 'completed'` (the terminal shape
//     every existing reader already understands), PLUS `reconciledAt` and
//     `reconciledFromStep` so the run stays distinguishable from one that WALKED
//     to done — `step` is overwritten, so without them that fact is destroyed;
//   * WHAT IT LEAVES ALONE — a run whose project marker is null, AT EVERY STEP
//     (the in-flight journey, the regression risk MOTIR-2090 had too), and
//     already-terminal runs;
//   * ORDER WITHIN THE LANE — reconcile before the index repair, so an orphaned
//     run records the step the user actually stopped at;
//   * IDEMPOTENCE — a second tick over reconciled state is a no-op;
//   * CONCURRENCY — the row lock + the re-assert under it, driven by HOLDING the
//     lock from the test body (never `Promise.all` + hope), and mutation-checked:
//     the closing test's own comment records what reddens when `lockById` goes.

/** Every step a run can be orphaned at — the reconciliation is deliberately NOT
 *  step-filtered, because the marker's non-wizard writers stamp it wherever the
 *  run happens to be. */
const EVERY_STEP: MigrateOnboardingStep[] = [
  'connect',
  'index',
  'import',
  'audit_convention',
  'discovery',
  'generate',
  'review',
];

/** Seed a migrate run directly at a given step/status — the orphaned-state
 *  fixture (the repository reach is allowed for tests). */
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

/** Stamp the durable "this project is established" marker — what
 *  `approvePlan` / the dogfood seed / the MOTIR-1799 operator stamp all write. */
async function establishProject(fx: WorkItemFixture, at = new Date()) {
  await db.project.update({ where: { id: fx.projectId }, data: { onboardingRanAt: at } });
}

async function readRun(id: string) {
  return db.migrateOnboarding.findUniqueOrThrow({ where: { id } });
}

beforeEach(async () => {
  await db.$executeRawUnsafe('TRUNCATE TABLE "migrate_onboarding" RESTART IDENTITY CASCADE');
  await truncateJobRuns();
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the reconciliation completes an orphaned run — both producers', () => {
  it('terminates the APPROVE RACE: a run left at review on an established project', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'review', connectedRepoRef: 'acme/widgets' });
    await establishProject(fx);

    const summary = await migrateOnboardingService.runTerminalReconciliation();

    expect(summary).toEqual({ scanned: 1, terminated: 1, failed: 0 });
    const after = await readRun(run.id);
    expect(after.status).toBe('completed');
    expect(after.step).toBe('done');
  });

  it('terminates the SEED / OPERATOR case: the live MOTIR shape, active at index', async () => {
    // The live row this card was filed on: the marker was stamped by
    // `scripts/stampOnboardingRan.ts` with no wizard involved, so the run sat at
    // `index` — a step MOTIR-2082's sweep can only move to `import`, never end.
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'index', connectedRepoRef: 'moooon-B-V/motir-ai' });
    await establishProject(fx, new Date('2026-08-04T16:33:50.782Z'));

    const summary = await migrateOnboardingService.runTerminalReconciliation();

    expect(summary).toEqual({ scanned: 1, terminated: 1, failed: 0 });
    const after = await readRun(run.id);
    expect(after.status).toBe('completed');
    expect(after.step).toBe('done');
  });

  it.each(EVERY_STEP)('terminates a run orphaned at %s — no step is out of scope', async (step) => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step });
    await establishProject(fx);

    const summary = await migrateOnboardingService.runTerminalReconciliation();

    expect(summary.terminated).toBe(1);
    const after = await readRun(run.id);
    expect(after.status).toBe('completed');
    expect(after.step).toBe('done');
  });
});

describe('a reconciled run stays distinguishable from one that WALKED to done', () => {
  it('stamps reconciledAt and the step it was actually parked at', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'discovery' });
    await establishProject(fx);
    const t0 = Date.now();

    await migrateOnboardingService.runTerminalReconciliation();

    const after = await readRun(run.id);
    // `step` is overwritten with `done`, so `reconciledFromStep` is the ONLY
    // surviving record of how far the journey actually got — the assertion that
    // matters most here, because the information is destroyed in place.
    expect(after.reconciledFromStep).toBe('discovery');
    expect(after.reconciledAt).toBeInstanceOf(Date);
    // A window, not an equality: the stamp is taken in this process and the row
    // is read back through Postgres.
    expect(Math.abs(after.reconciledAt!.getTime() - t0)).toBeLessThan(60_000);
  });

  it('leaves both columns NULL on a run the wizard walked to done itself', async () => {
    // The shipped `review → done` hop writes neither column, so `reconciledAt IS
    // NOT NULL` means exactly "terminated from the marker".
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'done', status: 'completed' });
    await establishProject(fx);

    await migrateOnboardingService.runTerminalReconciliation();

    const after = await readRun(run.id);
    expect(after.reconciledAt).toBeNull();
    expect(after.reconciledFromStep).toBeNull();
  });
});

describe('the reconciliation leaves the in-flight journey alone', () => {
  it.each(EVERY_STEP)(
    'never touches a run at %s whose project marker is still null',
    async (step) => {
      const fx = await makeWorkItemFixture();
      const run = await seedRun(fx, { step, connectedRepoRef: 'acme/widgets' });
      // No `establishProject` — this is a user mid-wizard, the whole population
      // that must not be terminated.

      const summary = await migrateOnboardingService.runTerminalReconciliation();

      expect(summary).toEqual({ scanned: 0, terminated: 0, failed: 0 });
      const after = await readRun(run.id);
      expect(after.step).toBe(step);
      expect(after.status).toBe('active');
      expect(after.reconciledAt).toBeNull();
    },
  );

  it.each(['completed', 'failed'] as const)(
    'never re-writes a %s run on an established project',
    async (status) => {
      const fx = await makeWorkItemFixture();
      const run = await seedRun(fx, { step: 'review', status });
      await establishProject(fx);

      const summary = await migrateOnboardingService.runTerminalReconciliation();

      expect(summary).toEqual({ scanned: 0, terminated: 0, failed: 0 });
      const after = await readRun(run.id);
      expect(after.status).toBe(status);
      expect(after.step).toBe('review');
    },
  );

  it('does not let one workspace’s marker terminate another’s run', async () => {
    // Two tenants, one established: only that one's run terminates. The scan
    // joins the run's OWN project, so a marker cannot leak across the boundary.
    const established = await makeWorkItemFixture({ name: 'Established', identifier: 'EST' });
    const fresh = await makeWorkItemFixture({ name: 'Fresh', identifier: 'FRSH' });
    const establishedRun = await seedRun(established, { step: 'review' });
    const freshRun = await seedRun(fresh, { step: 'review' });
    await establishProject(established);

    const summary = await migrateOnboardingService.runTerminalReconciliation();

    expect(summary).toEqual({ scanned: 1, terminated: 1, failed: 0 });
    expect((await readRun(establishedRun.id)).status).toBe('completed');
    expect((await readRun(freshRun.id)).status).toBe('active');
  });
});

describe('the reconciliation is idempotent and scans across workspaces in pages', () => {
  it('is a no-op on a second tick — the reconciled run has left the working set', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'review' });
    await establishProject(fx);

    await migrateOnboardingService.runTerminalReconciliation();
    const second = await migrateOnboardingService.runTerminalReconciliation();

    expect(second).toEqual({ scanned: 0, terminated: 0, failed: 0 });
    // The first tick's stamp is not re-written by the second.
    const after = await readRun(run.id);
    expect(after.reconciledFromStep).toBe('review');
  });

  it('reconciles runs in several workspaces in one tick, paging through them', async () => {
    const fixtures = await Promise.all([
      makeWorkItemFixture({ name: 'W1', identifier: 'W1' }),
      makeWorkItemFixture({ name: 'W2', identifier: 'W2' }),
      makeWorkItemFixture({ name: 'W3', identifier: 'W3' }),
    ]);
    const runs = [];
    for (const fx of fixtures) {
      runs.push(await seedRun(fx, { step: 'review' }));
      await establishProject(fx);
    }

    // A page size smaller than the population forces the keyset-cursor path —
    // over a set this tick is itself mutating out from under the scan.
    const summary = await migrateOnboardingService.runTerminalReconciliation({ pageSize: 2 });

    expect(summary).toEqual({ scanned: 3, terminated: 3, failed: 0 });
    for (const run of runs) {
      expect((await readRun(run.id)).status).toBe('completed');
    }
  });
});

describe('the lane runs the reconciliation BEFORE the index repair', () => {
  it('records the step the user actually stopped at, not the one a sweep moved it to', async () => {
    // An orphaned run parked at `index` whose index has since succeeded is in
    // scope for BOTH of the lane's steps. `migrateOnboardingSweep` calls them in
    // this order for exactly this reason: the other order would advance the run
    // to `import` first and then record a `reconciledFromStep` the user never
    // reached. This is the live MOTIR row's situation once its index lands.
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'index', connectedRepoRef: 'acme/widgets' });
    await establishProject(fx);
    await db.jobRun.create({
      data: {
        workspaceId: fx.workspaceId,
        functionId: 'system.code-graph-index',
        eventName: 'system.code-graph-index',
        eventId: 'evt-indexed',
        attempt: 0,
        status: 'succeeded',
        finishedAt: new Date(),
        output: { indexed: true, repoRef: 'acme/widgets', projectsIndexed: 1 },
      },
    });

    const reconciled = await migrateOnboardingService.runTerminalReconciliation();
    const indexed = await migrateOnboardingService.runIndexSweep();

    expect(reconciled).toEqual({ scanned: 1, terminated: 1, failed: 0 });
    // Terminated first, so it is no longer `active` and the index repair's own
    // filter skips it — the two steps need no coordination beyond the ordering.
    expect(indexed).toEqual({ scanned: 0, advanced: 0, failed: 0 });
    const after = await readRun(run.id);
    expect(after.step).toBe('done');
    expect(after.reconciledFromStep).toBe('index');
  });
});

describe('the reconciliation is concurrency-safe', () => {
  /**
   * Wait until some backend is actually WAITING on a lock. This is what makes the
   * interleaving DRIVEN rather than hoped for: if the reconciliation never
   * blocks, this throws and the test fails loudly instead of passing by accident.
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

  it('loses the race to a live wizard advance and produces exactly ONE transition', async () => {
    const fx = await makeWorkItemFixture();
    const run = await seedRun(fx, { step: 'review', connectedRepoRef: 'acme/widgets' });
    await establishProject(fx);

    // (1) The "wizard" takes the row lock and walks the real terminal hop — the
    // user WAS there, approved the plan, and the tab landed `review → done`. Its
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
          data: { step: 'done', status: 'completed' },
        });
        await held;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );

    // (2) The reconciliation starts, finds the run `active` at `review` (the
    // wizard has not committed, so its write is invisible), and blocks on the
    // row lock.
    const reconcile = migrateOnboardingService.runTerminalReconciliation();
    await waitForBlockedLock();

    // (3) The wizard commits. The reconciliation now takes the lock, RE-READS,
    // and sees `done` / `completed` — its re-assert fails and it no-ops.
    release();
    await wizard;
    const summary = await reconcile;

    expect(summary).toEqual({ scanned: 1, terminated: 0, failed: 0 });

    // THE MUTATION CHECK — RUN, not asserted from theory. Delete both `lockById`
    // calls (the one in `commitAdvance` and the one this lane takes before the
    // marker re-read — they are the same lock, taken twice in one transaction)
    // and this test reddens on the summary assertion above with
    // `terminated: 1`, and on the two stamp assertions below it. Without the
    // lock the reconciliation re-reads the stale pre-commit row (READ COMMITTED
    // hides the wizard's uncommitted write), passes its `review` + `active`
    // re-assert, and stamps `reconciledAt` / `reconciledFromStep: 'review'` over
    // a run the user genuinely WALKED to done — libelling a completed journey as
    // an abandoned one, and turning one transition into two.
    const after = await readRun(run.id);
    expect(after.status).toBe('completed');
    expect(after.reconciledAt).toBeNull();
    expect(after.reconciledFromStep).toBeNull();
  });
});
