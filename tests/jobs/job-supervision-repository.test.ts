import { Prisma, type JobQueueRun } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobSupervisionRepository } from '@/lib/repositories/jobSupervisionRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// `job_supervision` — the per-poll state one supervision carries BETWEEN passes
// (Story MOTIR-3778 · Subtask MOTIR-3826), against a real Postgres.
//
// `docs/decisions/job-queue-foundation.md` §16.2 decides the table; this file
// proves the three things the driver and the sweep are about to depend on:
//
//   * the row is keyed by `(run_id, subject)`, so an index run fanning out over
//     two projects holds TWO rows and neither can silently overwrite the other;
//   * `advance` is safe under the overlap a lease reclaim produces, because the
//     read that guards it LOCKS;
//   * the tenancy predicate bites — asserted with the actor's view and the true
//     population DIFFERENT, because a fixture in which they agree cannot tell a
//     scoped read from an unscoped one.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as a superuser with an
// implicit BYPASSRLS, so RLS is inert under it whatever `FORCE ROW LEVEL
// SECURITY` says. Every tenancy assertion below runs inside a transaction that
// `SET LOCAL ROLE motir_app`. Local copy of the helper, per the convention each
// RLS suite carries its own.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function makeWorkspace(): Promise<string> {
  seq += 1;
  const user = await usersService.createUser({
    email: `supervision-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Supervision ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Supervision WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

async function enqueue(workspaceId: string | null): Promise<JobQueueRun> {
  seq += 1;
  return adminDb.jobQueueRun.create({
    data: {
      jobId: `system.code-graph-index`,
      eventName: 'code-graph/index.requested',
      workspaceId,
      runAt: new Date(),
      maxAttempts: 3,
    },
  });
}

async function asAppRole<T>(
  ctx: { workspaceId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.systemAdmin) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

const later = (ms: number): Date => new Date(Date.now() + ms);

describe('the identity is (run_id, subject)', () => {
  it('an index run fanning out over TWO projects holds TWO rows', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);

    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: 'project-a',
          kind: 'index',
          nextPollAt: later(3_000),
          workspaceId: ws,
        },
        tx,
      );
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: 'project-b',
          kind: 'index',
          nextPollAt: later(3_000),
          workspaceId: ws,
        },
        tx,
      );
    });

    const rows = await withSystemContext((tx) => jobSupervisionRepository.listByRun(run.id, tx));
    expect(rows.map((r) => r.subject).sort()).toEqual(['project-a', 'project-b']);
    // The degenerate case is one row; the fan-out case is what a schema keyed by
    // `run_id` alone would have modelled as a singular.
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it('`open` on a LIVE supervision returns it untouched — a reclaimed pass may not reset the observations', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    const observedAt = new Date('2026-08-28T10:00:00.000Z');

    await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        { runId: run.id, subject: 'p1', kind: 'index', nextPollAt: later(3_000), workspaceId: ws },
        tx,
      ),
    );
    await withSystemContext((tx) =>
      jobSupervisionRepository.advance(
        run.id,
        'p1',
        { startedAt: observedAt, consecutiveReadFailures: 2, nextPollAt: later(6_000) },
        tx,
      ),
    );

    // The pass after a lease reclaim replays the boot from its memo and re-opens
    // the supervision. If `open` clobbered, a supervision would restart its poll
    // count and forget it had seen the container start.
    const reopened = await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: 'p1',
          kind: 'index',
          nextPollAt: later(999_000),
          workspaceId: ws,
        },
        tx,
      ),
    );
    expect(reopened.pollNumber).toBe(1);
    expect(reopened.startedAt?.toISOString()).toBe(observedAt.toISOString());
    expect(reopened.consecutiveReadFailures).toBe(2);
  });

  it('the UNIQUE is a constraint, not a convention — a second INSERT for the pair is P2002', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        { runId: run.id, subject: 'p1', kind: 'index', nextPollAt: later(3_000), workspaceId: ws },
        tx,
      ),
    );
    await expect(
      adminDb.jobSupervision.create({
        data: {
          runId: run.id,
          subject: 'p1',
          kind: 'index',
          nextPollAt: later(3_000),
          workspaceId: ws,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('advancing a poll', () => {
  it('increments the count in the DATABASE and replaces the observations', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        { runId: run.id, subject: 'p1', kind: 'index', nextPollAt: later(3_000), workspaceId: ws },
        tx,
      ),
    );

    let row = await withSystemContext((tx) =>
      jobSupervisionRepository.advance(
        run.id,
        'p1',
        { startedAt: null, consecutiveReadFailures: 1, nextPollAt: later(6_000) },
        tx,
      ),
    );
    expect(row.pollNumber).toBe(1);
    expect(row.startedAt).toBeNull();
    expect(row.consecutiveReadFailures).toBe(1);

    // A successful read clears the failure tally and records the observation —
    // §13.1's corollary: the verdict is gated on POSITIVE evidence.
    const started = new Date('2026-08-28T10:05:00.000Z');
    row = await withSystemContext((tx) =>
      jobSupervisionRepository.advance(
        run.id,
        'p1',
        { startedAt: started, consecutiveReadFailures: 0, nextPollAt: later(12_000) },
        tx,
      ),
    );
    expect(row.pollNumber).toBe(2);
    expect(row.startedAt?.toISOString()).toBe(started.toISOString());
    expect(row.consecutiveReadFailures).toBe(0);
  });

  it('the guarding read LOCKS — two overlapping advances serialise instead of both writing poll 1', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        { runId: run.id, subject: 'p1', kind: 'index', nextPollAt: later(3_000), workspaceId: ws },
        tx,
      ),
    );

    // The overlap a lease reclaim produces: the first worker is still inside its
    // provider call when a second claims the run. A serial test cannot see this
    // — both would read and write in order — so drive genuine concurrency.
    const seen: number[] = [];
    const advanceOnce = async (delayMs: number): Promise<void> => {
      await withSystemContext(async (tx) => {
        const locked = await jobSupervisionRepository.findByRunAndSubjectForUpdate(
          run.id,
          'p1',
          tx,
        );
        seen.push(locked!.pollNumber);
        await new Promise((r) => setTimeout(r, delayMs));
        await jobSupervisionRepository.advance(
          run.id,
          'p1',
          { startedAt: null, consecutiveReadFailures: 0, nextPollAt: later(6_000) },
          tx,
        );
      });
    };

    await Promise.all([advanceOnce(120), advanceOnce(0)]);

    const row = await withSystemContext((tx) =>
      jobSupervisionRepository.findByRunAndSubject(run.id, 'p1', tx),
    );
    expect(row!.pollNumber).toBe(2);
    // The lock is what makes the SECOND reader observe the first's write. With a
    // plain read both would have seen 0.
    expect(seen.sort()).toEqual([0, 1]);
  });

  it('`findByRunAndSubjectForUpdate` returns null for a pair that does not exist', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    const row = await withSystemContext((tx) =>
      jobSupervisionRepository.findByRunAndSubjectForUpdate(run.id, 'nope', tx),
    );
    expect(row).toBeNull();
  });

  it('its raw SELECT returns the row in the MODEL’s shape, camel-cased — not the column names', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    const started = new Date('2026-08-28T11:00:00.000Z');
    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: 'p1',
          kind: 'ci-runner',
          nextPollAt: later(3_000),
          workspaceId: ws,
        },
        tx,
      );
      await jobSupervisionRepository.advance(
        run.id,
        'p1',
        { startedAt: started, consecutiveReadFailures: 3, nextPollAt: later(9_000) },
        tx,
      );
    });

    const [locked, plain] = await withSystemContext(async (tx) => [
      await jobSupervisionRepository.findByRunAndSubjectForUpdate(run.id, 'p1', tx),
      await jobSupervisionRepository.findByRunAndSubject(run.id, 'p1', tx),
    ]);
    // A hand-written alias list is one rename away from handing the driver an
    // object with the right values under the wrong keys, so assert it against
    // the client's own mapping rather than against a literal.
    expect(locked).toEqual(plain);
  });
});

describe('the lifecycle and the sweep read', () => {
  it('`markState` moves watching -> settling -> settled', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        { runId: run.id, subject: 'p1', kind: 'index', nextPollAt: later(3_000), workspaceId: ws },
        tx,
      ),
    );
    expect(
      (
        await withSystemContext((tx) =>
          jobSupervisionRepository.markState(run.id, 'p1', 'settling', tx),
        )
      ).state,
    ).toBe('settling');
    expect(
      (
        await withSystemContext((tx) =>
          jobSupervisionRepository.markState(run.id, 'p1', 'settled', tx),
        )
      ).state,
    ).toBe('settled');
  });

  it('`listStalled` returns only `watching` rows whose next poll is already past', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    const cutoff = new Date('2026-08-28T12:00:00.000Z');

    await withSystemContext(async (tx) => {
      // Stalled: due long before the cutoff, still watching.
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: 'stalled',
          kind: 'index',
          nextPollAt: new Date('2026-08-28T11:00:00.000Z'),
          workspaceId: ws,
        },
        tx,
      );
      // Healthy: due AFTER the cutoff — a chain that is simply waiting.
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: 'healthy',
          kind: 'index',
          nextPollAt: new Date('2026-08-28T13:00:00.000Z'),
          workspaceId: ws,
        },
        tx,
      );
      // Old but already SETTLING — teardown is in flight and must not be
      // entered a second time by the sweep.
      await jobSupervisionRepository.open(
        {
          runId: run.id,
          subject: 'tearing-down',
          kind: 'index',
          nextPollAt: new Date('2026-08-28T10:00:00.000Z'),
          workspaceId: ws,
        },
        tx,
      );
      await jobSupervisionRepository.markState(run.id, 'tearing-down', 'settling', tx);
    });

    const stalled = await withSystemContext((tx) =>
      jobSupervisionRepository.listStalled(cutoff, tx),
    );
    expect(stalled.map((r) => r.subject)).toEqual(['stalled']);
  });

  it('`listStalled` orders oldest-first and honours its limit', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    await withSystemContext(async (tx) => {
      for (const [subject, minute] of [
        ['third', '11:30'],
        ['first', '09:00'],
        ['second', '10:15'],
      ] as const) {
        await jobSupervisionRepository.open(
          {
            runId: run.id,
            subject,
            kind: 'index',
            nextPollAt: new Date(`2026-08-28T${minute}:00.000Z`),
            workspaceId: ws,
          },
          tx,
        );
      }
    });

    const cutoff = new Date('2026-08-28T12:00:00.000Z');
    const all = await withSystemContext((tx) => jobSupervisionRepository.listStalled(cutoff, tx));
    expect(all.map((r) => r.subject)).toEqual(['first', 'second', 'third']);
    const capped = await withSystemContext((tx) =>
      jobSupervisionRepository.listStalled(cutoff, tx, 2),
    );
    expect(capped.map((r) => r.subject)).toEqual(['first', 'second']);
  });

  it('`deleteByRun` leaves nothing behind — the table tracks live supervisions, not history', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    const other = await enqueue(ws);
    await withSystemContext(async (tx) => {
      await jobSupervisionRepository.open(
        { runId: run.id, subject: 'a', kind: 'index', nextPollAt: later(1_000), workspaceId: ws },
        tx,
      );
      await jobSupervisionRepository.open(
        { runId: run.id, subject: 'b', kind: 'index', nextPollAt: later(1_000), workspaceId: ws },
        tx,
      );
      await jobSupervisionRepository.open(
        { runId: other.id, subject: 'a', kind: 'index', nextPollAt: later(1_000), workspaceId: ws },
        tx,
      );
    });

    const deleted = await withSystemContext((tx) =>
      jobSupervisionRepository.deleteByRun(run.id, tx),
    );
    expect(deleted).toBe(2);
    expect(await withSystemContext((tx) => jobSupervisionRepository.listByRun(run.id, tx))).toEqual(
      [],
    );
    // Scoped to the run it was given — the sibling run's supervision survives.
    expect(
      await withSystemContext((tx) => jobSupervisionRepository.listByRun(other.id, tx)),
    ).toHaveLength(1);
  });

  it('the run being deleted CASCADES the supervision away', async () => {
    const ws = await makeWorkspace();
    const run = await enqueue(ws);
    await withSystemContext((tx) =>
      jobSupervisionRepository.open(
        { runId: run.id, subject: 'p1', kind: 'index', nextPollAt: later(1_000), workspaceId: ws },
        tx,
      ),
    );
    await adminDb.jobQueueRun.delete({ where: { id: run.id } });
    expect(await adminDb.jobSupervision.count({ where: { runId: run.id } })).toBe(0);
  });
});

describe('tenancy — the policy bites under the non-bypass role', () => {
  /**
   * THREE rows, in three tenancies, so the actor's view and the true population
   * DIFFER. A fixture where they agree cannot tell a scoped read from an
   * unscoped one: every assertion would pass against a table with no policy at
   * all.
   */
  async function seedThreeTenancies(): Promise<{
    w1: string;
    w2: string;
    ids: { w1: string; w2: string; system: string };
  }> {
    const w1 = await makeWorkspace();
    const w2 = await makeWorkspace();
    const runW1 = await enqueue(w1);
    const runW2 = await enqueue(w2);
    const runSystem = await enqueue(null);
    const ids = await withSystemContext(async (tx) => ({
      w1: (
        await jobSupervisionRepository.open(
          {
            runId: runW1.id,
            subject: 'p',
            kind: 'index',
            nextPollAt: later(1_000),
            workspaceId: w1,
          },
          tx,
        )
      ).id,
      w2: (
        await jobSupervisionRepository.open(
          {
            runId: runW2.id,
            subject: 'p',
            kind: 'index',
            nextPollAt: later(1_000),
            workspaceId: w2,
          },
          tx,
        )
      ).id,
      system: (
        await jobSupervisionRepository.open(
          {
            runId: runSystem.id,
            subject: 'p',
            kind: 'ci-runner',
            nextPollAt: later(1_000),
            workspaceId: null,
          },
          tx,
        )
      ).id,
    }));
    return { w1, w2, ids };
  }

  it('the table IS row-security-active for the runtime role', async () => {
    const active = await asAppRole(
      { systemAdmin: true },
      (tx) =>
        tx.$queryRaw<{ on: boolean }[]>`SELECT row_security_active('job_supervision') AS "on"`,
    );
    expect(active[0]!.on).toBe(true);
  });

  it('with NO context bound, the runtime role sees ZERO rows — the safe failure mode', async () => {
    await seedThreeTenancies();
    expect(await asAppRole({}, (tx) => tx.jobSupervision.findMany())).toEqual([]);
  });

  it("bound to W1, only W1's row is visible — never W2's, never the system one", async () => {
    const fx = await seedThreeTenancies();
    const rows = await asAppRole({ workspaceId: fx.w1 }, (tx) => tx.jobSupervision.findMany());
    expect(rows.map((r) => r.id)).toEqual([fx.ids.w1]);
    // The population is THREE. A scoped read returning one is the whole proof.
    expect(await adminDb.jobSupervision.count()).toBe(3);
  });

  it('the system-admin branch reaches every row, including the untenanted one', async () => {
    const fx = await seedThreeTenancies();
    const rows = await asAppRole({ systemAdmin: true }, (tx) => tx.jobSupervision.findMany());
    expect(rows.map((r) => r.id).sort()).toEqual([fx.ids.system, fx.ids.w1, fx.ids.w2].sort());
  });

  it('a tenant cannot UPDATE a foreign row — the write is invisible, not merely refused', async () => {
    const fx = await seedThreeTenancies();
    await expect(
      asAppRole({ workspaceId: fx.w1 }, (tx) =>
        tx.jobSupervision.update({
          where: { id: fx.ids.w2 },
          data: { consecutiveReadFailures: 9 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });
    const untouched = await adminDb.jobSupervision.findUniqueOrThrow({
      where: { id: fx.ids.w2 },
    });
    expect(untouched.consecutiveReadFailures).toBe(0);
  });

  it('WITH CHECK refuses an INSERT into another tenant', async () => {
    const fx = await seedThreeTenancies();
    const foreignRun = await enqueue(fx.w2);
    await expect(
      asAppRole({ workspaceId: fx.w1 }, (tx) =>
        tx.jobSupervision.create({
          data: {
            runId: foreignRun.id,
            subject: 'smuggled',
            kind: 'index',
            nextPollAt: later(1_000),
            workspaceId: fx.w2,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('a tenant cannot DELETE a foreign row', async () => {
    const fx = await seedThreeTenancies();
    const deleted = await asAppRole({ workspaceId: fx.w1 }, (tx) =>
      tx.jobSupervision.deleteMany({ where: { id: fx.ids.w2 } }),
    );
    expect(deleted.count).toBe(0);
    expect(await adminDb.jobSupervision.count({ where: { id: fx.ids.w2 } })).toBe(1);
  });
});
