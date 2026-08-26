import { Prisma } from '@/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { dispatchEventToEngine } from '@/lib/jobs/engine/dispatcher';

// The Postgres job engine's SCHEMA (Story MOTIR-3414 · Subtask MOTIR-3420) —
// the three tables' structural guarantees, proved against a real Postgres.
//
// This file asserts the properties the migration is FOR, and each is asserted by
// making the database refuse something rather than by reading the schema back:
//
//   1. `(run_id, step_id)` is UNIQUE on `job_step` — the memoization key. A
//      duplicate INSERT is rejected. (Reading `pg_index` would prove the index
//      exists; only inserting proves it constrains.)
//   2. `(event_id, job_id)` is UNIQUE on `job_queue` — fan-out idempotency —
//      AND it does not constrain scheduled runs, whose `event_id` is NULL.
//   2b. `(job_id, scheduled_for)` is UNIQUE on `job_queue` — TICK idempotency
//      (MOTIR-3469) — AND it does not constrain event-triggered runs, whose
//      `scheduled_for` is NULL. The two constraints are complementary halves of
//      one idea and each is asserted the same way: by making the database refuse
//      the duplicate, and by making it ADMIT the population the other covers.
//   3. RLS denies cross-tenant reads and writes on all three tables, under the
//      non-bypass `motir_app` role.
//   4. The FKs cascade, in both directions the engine depends on.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI database's owner role is a
// superuser and BYPASSES RLS regardless of FORCE ROW LEVEL SECURITY. Every
// tenancy assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE motir_app`. Without that switch each one would assert the
// OPPOSITE of reality and pass. The `asAppRole` helper is a local copy, per the
// convention each RLS suite in this tree carries its own.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

// AFTER as well as before: these tables sit outside the workspace cascade, so a
// suite that only cleared them up-front would leave its last test's rows for
// whatever file this worker runs next.
afterEach(async () => {
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface EngineFixture {
  workspaceW1Id: string;
  workspaceW2Id: string;
  eventW1Id: string;
  eventW2Id: string;
  eventSystemId: string;
  runW1Id: string;
  runW2Id: string;
  runSystemId: string;
  stepW1Id: string;
  stepW2Id: string;
}

let seq = 0;
function uniq(): string {
  seq += 1;
  return `engine-seed-${seq}`;
}

async function seedEvent(workspaceId: string | null): Promise<string> {
  const row = await adminDb.jobEvent.create({
    data: {
      name: 'work-item/transitioned',
      data: { workspaceId, marker: uniq() },
      workspace: workspaceId ? { connect: { id: workspaceId } } : undefined,
    },
  });
  return row.id;
}

async function seedRun(eventId: string | null, workspaceId: string | null): Promise<string> {
  const row = await adminDb.jobQueueRun.create({
    data: {
      jobId: `job.${uniq()}`,
      event: eventId ? { connect: { id: eventId } } : undefined,
      eventName: 'work-item/transitioned',
      workspace: workspaceId ? { connect: { id: workspaceId } } : undefined,
      runAt: new Date(),
      maxAttempts: 3,
    },
  });
  return row.id;
}

async function seedStep(runId: string, workspaceId: string | null): Promise<string> {
  const row = await adminDb.jobStep.create({
    data: {
      run: { connect: { id: runId } },
      stepId: uniq(),
      result: { ok: true },
      workspace: workspaceId ? { connect: { id: workspaceId } } : undefined,
    },
  });
  return row.id;
}

// Two tenants plus one untenanted (system) chain, mirroring tests/jobs/rls.ts's
// shape — the system rows are what make the null-workspace branch testable.
async function makeFixture(): Promise<EngineFixture> {
  const userA = await usersService.createUser({
    email: 'engine-schema-a@example.com',
    password: 'hunter2hunter2',
    name: 'Engine Schema A',
  });
  const userB = await usersService.createUser({
    email: 'engine-schema-b@example.com',
    password: 'hunter2hunter2',
    name: 'Engine Schema B',
  });
  const w1 = await workspacesService.createWorkspace({
    name: 'Engine WS 1',
    ownerUserId: userA.id,
  });
  const w2 = await workspacesService.createWorkspace({
    name: 'Engine WS 2',
    ownerUserId: userB.id,
  });
  const w1Id = w1.workspace.id;
  const w2Id = w2.workspace.id;

  const eventW1Id = await seedEvent(w1Id);
  const eventW2Id = await seedEvent(w2Id);
  const eventSystemId = await seedEvent(null);
  const runW1Id = await seedRun(eventW1Id, w1Id);
  const runW2Id = await seedRun(eventW2Id, w2Id);
  const runSystemId = await seedRun(eventSystemId, null);

  return {
    workspaceW1Id: w1Id,
    workspaceW2Id: w2Id,
    eventW1Id,
    eventW2Id,
    eventSystemId,
    runW1Id,
    runW2Id,
    runSystemId,
    stepW1Id: await seedStep(runW1Id, w1Id),
    stepW2Id: await seedStep(runW2Id, w2Id),
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally binds app.workspace_id /
 * app.user_id / app.system_admin and (b) drops to the non-bypass `motir_app`
 * role for the duration. The role switch is what makes RLS bite; it reverts at
 * transaction end.
 */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
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

describe('job_step — the (run_id, step_id) memoization key', () => {
  it('REFUSES a second row with the same (run_id, step_id)', async () => {
    const fx = await makeFixture();
    await adminDb.jobStep.create({
      data: {
        run: { connect: { id: fx.runW1Id } },
        stepId: 'send-the-email',
        result: { messageId: 'first' },
        workspace: { connect: { id: fx.workspaceW1Id } },
      },
    });

    // The duplicate is what proves the constraint. This is the whole reason
    // `step.run` can be "look up, else execute, persist" without a lock: a
    // concurrent or replayed second execution cannot land a second row.
    await expect(
      adminDb.jobStep.create({
        data: {
          run: { connect: { id: fx.runW1Id } },
          stepId: 'send-the-email',
          result: { messageId: 'second' },
          workspace: { connect: { id: fx.workspaceW1Id } },
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const rows = await adminDb.jobStep.findMany({
      where: { runId: fx.runW1Id, stepId: 'send-the-email' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result).toEqual({ messageId: 'first' });
  });

  it('ADMITS the same step_id under a DIFFERENT run — the key is the pair', async () => {
    const fx = await makeFixture();
    // A retried job is a new run; its steps repeat the same author-supplied ids
    // and must not collide with the previous run's.
    await adminDb.jobStep.create({
      data: {
        run: { connect: { id: fx.runW1Id } },
        stepId: 'shared-step-id',
        workspace: { connect: { id: fx.workspaceW1Id } },
      },
    });
    const second = await adminDb.jobStep.create({
      data: {
        run: { connect: { id: fx.runW2Id } },
        stepId: 'shared-step-id',
        workspace: { connect: { id: fx.workspaceW2Id } },
      },
    });
    expect(second.stepId).toBe('shared-step-id');
  });

  it('records a sleep checkpoint distinguishably from a step that returned null', async () => {
    const fx = await makeFixture();
    const wake = new Date(Date.now() + 60_000);
    const sleep = await adminDb.jobStep.create({
      data: {
        run: { connect: { id: fx.runW1Id } },
        stepId: 'wait-for-capacity',
        kind: 'sleep',
        sleepUntil: wake,
        workspace: { connect: { id: fx.workspaceW1Id } },
      },
    });
    const nullResult = await adminDb.jobStep.create({
      data: {
        run: { connect: { id: fx.runW1Id } },
        stepId: 'returned-nothing',
        kind: 'run',
        workspace: { connect: { id: fx.workspaceW1Id } },
      },
    });

    // Both have `result: null`. `kind` is what keeps them apart — the shim must
    // resume a sleep and must NOT re-execute a run that legitimately returned
    // nothing, and a nullable result column alone cannot express the difference.
    expect(sleep.result).toBeNull();
    expect(nullResult.result).toBeNull();
    expect(sleep.kind).toBe('sleep');
    expect(nullResult.kind).toBe('run');
    expect(sleep.sleepUntil?.getTime()).toBe(wake.getTime());
    expect(nullResult.sleepUntil).toBeNull();
  });
});

describe('job_queue — fan-out idempotency', () => {
  it('REFUSES a second run for the same (event_id, job_id)', async () => {
    const fx = await makeFixture();
    await adminDb.jobQueueRun.create({
      data: {
        jobId: 'watcher.notify',
        event: { connect: { id: fx.eventW1Id } },
        eventName: 'work-item/transitioned',
        workspace: { connect: { id: fx.workspaceW1Id } },
        runAt: new Date(),
        maxAttempts: 3,
      },
    });

    // A dispatcher that retries mid-fan-out re-enqueues what it already wrote.
    // The constraint is what makes that safe rather than doubling the run.
    await expect(
      adminDb.jobQueueRun.create({
        data: {
          jobId: 'watcher.notify',
          event: { connect: { id: fx.eventW1Id } },
          eventName: 'work-item/transitioned',
          workspace: { connect: { id: fx.workspaceW1Id } },
          runAt: new Date(),
          maxAttempts: 3,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('ADMITS several jobs for ONE event — that is what fan-out IS', async () => {
    const fx = await makeFixture();
    for (const jobId of ['mention.notify', 'watcher.notify', 'notification.fan-in']) {
      await adminDb.jobQueueRun.create({
        data: {
          jobId,
          event: { connect: { id: fx.eventW1Id } },
          eventName: 'work-item/transitioned',
          workspace: { connect: { id: fx.workspaceW1Id } },
          runAt: new Date(),
          maxAttempts: 3,
        },
      });
    }
    const runs = await adminDb.jobQueueRun.findMany({ where: { eventId: fx.eventW1Id } });
    // Three plus the one the fixture seeded.
    expect(runs).toHaveLength(4);
  });

  it('does NOT constrain SCHEDULED runs, which carry a null event_id', async () => {
    await makeFixture();
    // Two ticks of the same cron are two runs and must both exist. In Postgres a
    // NULL is distinct from every other NULL in a unique index, so the
    // constraint above simply does not apply to them — asserted rather than
    // assumed, because the whole scheduled story (MOTIR-3416) rests on it.
    for (let i = 0; i < 2; i++) {
      await adminDb.jobQueueRun.create({
        data: {
          jobId: 'system.attachment-gc',
          eventName: 'scheduled.system.attachment-gc',
          runAt: new Date(),
          maxAttempts: 5,
        },
      });
    }
    const runs = await adminDb.jobQueueRun.findMany({
      where: { jobId: 'system.attachment-gc' },
    });
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.eventId === null)).toBe(true);
  });
});

describe('job_queue — the per-tick key (MOTIR-3469)', () => {
  const FIRE = new Date(Date.UTC(2026, 7, 25, 3, 30, 0));
  const LATER_FIRE = new Date(Date.UTC(2026, 7, 26, 3, 30, 0));

  it('REFUSES a second row for the same (job_id, scheduled_for)', async () => {
    await makeFixture();
    await adminDb.jobQueueRun.create({
      data: {
        jobId: 'system.attachment-gc',
        eventName: 'scheduled.system.attachment-gc',
        runAt: FIRE,
        scheduledFor: FIRE,
        maxAttempts: 5,
      },
    });

    // This is the whole defect the column closes. Before it, both workers'
    // inserts succeeded — `event_id` is NULL on a scheduled run, and in Postgres
    // a NULL never equals a NULL, so `(event_id, job_id)` could not see them.
    await expect(
      adminDb.jobQueueRun.create({
        data: {
          jobId: 'system.attachment-gc',
          eventName: 'scheduled.system.attachment-gc',
          runAt: FIRE,
          scheduledFor: FIRE,
          maxAttempts: 5,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const rows = await adminDb.jobQueueRun.findMany({ where: { jobId: 'system.attachment-gc' } });
    expect(rows).toHaveLength(1);
  });

  it('ADMITS two fire times for the SAME job — the key is the pair', async () => {
    await makeFixture();
    for (const fire of [FIRE, LATER_FIRE]) {
      await adminDb.jobQueueRun.create({
        data: {
          jobId: 'system.attachment-gc',
          eventName: 'scheduled.system.attachment-gc',
          runAt: fire,
          scheduledFor: fire,
          maxAttempts: 5,
        },
      });
    }
    const rows = await adminDb.jobQueueRun.findMany({ where: { jobId: 'system.attachment-gc' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.scheduledFor?.getTime()).sort()).toEqual(
      [FIRE.getTime(), LATER_FIRE.getTime()].sort(),
    );
  });

  it('does NOT constrain EVENT-triggered runs, which carry a null scheduled_for', async () => {
    const fx = await makeFixture();
    // The mirror of the `(event_id, job_id)` block above, and the reason the two
    // constraints can coexist on one table: each is blind to the other's rows.
    const second = await seedEvent(fx.workspaceW1Id);
    for (const eventId of [fx.eventW1Id, second]) {
      await adminDb.jobQueueRun.create({
        data: {
          jobId: 'watcher.notify',
          event: { connect: { id: eventId } },
          eventName: 'work-item/transitioned',
          workspace: { connect: { id: fx.workspaceW1Id } },
          runAt: new Date(),
          maxAttempts: 3,
        },
      });
    }
    const rows = await adminDb.jobQueueRun.findMany({ where: { jobId: 'watcher.notify' } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.scheduledFor === null)).toBe(true);
  });

  it('enqueueScheduled REPORTS already-queued rather than throwing', async () => {
    await makeFixture();
    const args = {
      jobId: 'system.rate-limit-sweep',
      scheduledFor: FIRE,
      eventName: 'scheduled.system.rate-limit-sweep',
      runAt: FIRE,
      maxAttempts: 5,
    };

    const first = await withSystemContext((tx) => jobQueueRepository.enqueueScheduled(args, tx));
    const second = await withSystemContext((tx) => jobQueueRepository.enqueueScheduled(args, tx));

    // A second worker's tick is a NORMAL outcome, not an error — the caller must
    // be able to tell the two apart without inspecting a thrown value.
    expect(first.outcome).toBe('enqueued');
    expect(second.outcome).toBe('already-queued');
    expect(await adminDb.jobQueueRun.count({ where: { jobId: args.jobId } })).toBe(1);
  });

  it('writes the row the scheduler contract specifies', async () => {
    await makeFixture();
    const result = await withSystemContext((tx) =>
      jobQueueRepository.enqueueScheduled(
        {
          jobId: 'system.daily-health-check',
          scheduledFor: FIRE,
          eventName: 'scheduled.system.daily-health-check',
          runAt: FIRE,
          maxAttempts: 1,
        },
        tx,
      ),
    );
    expect(result.outcome).toBe('enqueued');

    const row = await adminDb.jobQueueRun.findFirstOrThrow({
      where: { jobId: 'system.daily-health-check' },
    });
    // `event_name` is asserted here rather than left to the scheduler because
    // three separate consumers read it — `jobScheduleHealthService` groups on
    // exactly `scheduled.{functionId}`, and a typo would make every migrated cron
    // job read as permanently overdue.
    expect(row.eventName).toBe('scheduled.system.daily-health-check');
    expect(row.eventId).toBeNull();
    expect(row.workspaceId).toBeNull();
    expect(row.scheduledFor?.getTime()).toBe(FIRE.getTime());
    expect(row.runAt.getTime()).toBe(FIRE.getTime());
    expect(row.maxAttempts).toBe(1);
    expect(row.state).toBe('pending');
  });

  it('TWO CONCURRENT enqueues of the same tick produce exactly ONE row', async () => {
    await makeFixture();
    const args = {
      jobId: 'system.ci-runner-reap',
      scheduledFor: FIRE,
      eventName: 'scheduled.system.ci-runner-reap',
      runAt: FIRE,
      maxAttempts: 5,
    };

    // ⚠️ GENUINELY CONCURRENT, and that is the point. Two SEQUENTIAL calls pass
    // against a check-then-insert with no constraint under it — the second read
    // simply sees the first row. The race this closes needs both inserts in
    // flight at once against a warm pool, which is the same argument
    // `claimDueRuns` makes about its own claim one file over.
    const [a, b] = await Promise.all([
      withSystemContext((tx) => jobQueueRepository.enqueueScheduled(args, tx)),
      withSystemContext((tx) => jobQueueRepository.enqueueScheduled(args, tx)),
    ]);

    // Either interleaving is legitimate; what must never happen is two rows.
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['already-queued', 'enqueued']);
    expect(await adminDb.jobQueueRun.count({ where: { jobId: args.jobId } })).toBe(1);
  });

  it('leaves the EVENT-triggered enqueue path exactly as it was', async () => {
    const fx = await makeFixture();
    // The scope boundary, asserted rather than assumed: this card touches the
    // dispatcher not at all, so its own idempotency must still be the
    // `(event_id, job_id)` constraint and its rows must still carry no fire time.
    const first = await dispatchEventToEngine('work-item/transitioned', {
      workspaceId: fx.workspaceW1Id,
    });
    const replay = await dispatchEventToEngine('work-item/transitioned', {
      workspaceId: fx.workspaceW1Id,
    });

    // Nothing is routed to the engine in this suite's environment, so both calls
    // return the no-subscriber shape. That is the assertion: the dispatcher's
    // behaviour is unchanged, and the new column did not give it a second lane.
    expect(first.failed).toEqual([]);
    expect(replay.failed).toEqual([]);
    const scheduledRows = await adminDb.jobQueueRun.findMany({
      where: { scheduledFor: { not: null } },
    });
    expect(scheduledRows).toEqual([]);
  });

  it('the system-admin branch admits an enqueueScheduled write under the app role', async () => {
    const fx = await makeFixture();
    // RLS on `job_queue` is UNCHANGED by this card, and a new write path is
    // exactly where that would silently stop being true: an untenanted row is
    // admitted only by the policy's system-admin arm, which is the context the
    // worker runs under.
    const created = await asAppRole({ systemAdmin: true }, (tx) =>
      jobQueueRepository.enqueueScheduled(
        {
          jobId: 'system.plan-target-lock-sweep',
          scheduledFor: FIRE,
          eventName: 'scheduled.system.plan-target-lock-sweep',
          runAt: FIRE,
          maxAttempts: 5,
        },
        tx,
      ),
    );
    expect(created.outcome).toBe('enqueued');

    // And a TENANT context is still refused — the write path inherits the
    // policy rather than routing around it.
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.jobQueueRun.create({
          data: {
            jobId: 'system.smuggled-sweep',
            eventName: 'scheduled.system.smuggled-sweep',
            runAt: FIRE,
            scheduledFor: FIRE,
            maxAttempts: 5,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe('the job engine tables — RLS read isolation', () => {
  it('with NO context bound, motir_app sees zero rows in all three tables', async () => {
    await makeFixture();
    const seen = await asAppRole({}, async (tx) => ({
      events: await tx.jobEvent.findMany(),
      runs: await tx.jobQueueRun.findMany(),
      steps: await tx.jobStep.findMany(),
    }));
    expect(seen.events).toEqual([]);
    expect(seen.runs).toEqual([]);
    expect(seen.steps).toEqual([]);
  });

  it("with W1 bound, only W1's rows are visible — never W2's, never the system rows", async () => {
    const fx = await makeFixture();
    const seen = await asAppRole({ workspaceId: fx.workspaceW1Id }, async (tx) => ({
      events: (await tx.jobEvent.findMany()).map((r) => r.id),
      runs: (await tx.jobQueueRun.findMany()).map((r) => r.id),
      steps: (await tx.jobStep.findMany()).map((r) => r.id),
    }));

    expect(seen.events).toEqual([fx.eventW1Id]);
    expect(seen.events).not.toContain(fx.eventW2Id);
    expect(seen.events).not.toContain(fx.eventSystemId);
    expect(seen.runs).toEqual([fx.runW1Id]);
    expect(seen.runs).not.toContain(fx.runSystemId);
    expect(seen.steps).toEqual([fx.stepW1Id]);
    expect(seen.steps).not.toContain(fx.stepW2Id);
  });

  it('the system-admin branch reaches every row, including the untenanted ones', async () => {
    const fx = await makeFixture();
    const seen = await asAppRole({ systemAdmin: true }, async (tx) => ({
      events: (await tx.jobEvent.findMany()).map((r) => r.id),
      runs: (await tx.jobQueueRun.findMany()).map((r) => r.id),
    }));
    // This is the branch the worker itself runs under: it must be able to claim
    // a system job's run, which no tenant context can see.
    expect(seen.events).toContain(fx.eventSystemId);
    expect(seen.runs).toContain(fx.runSystemId);
    expect(seen.events).toHaveLength(3);
  });

  it('a tenant cannot reach another tenant a step at a time either', async () => {
    const fx = await makeFixture();
    const row = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.jobStep.findUnique({ where: { id: fx.stepW2Id } }),
    );
    // A direct by-id read is the shape that would leak if the policy were only
    // applied to list queries.
    expect(row).toBeNull();
  });
});

describe('the job engine tables — RLS write isolation', () => {
  it('a tenant CANNOT insert a run into another workspace (WITH CHECK)', async () => {
    const fx = await makeFixture();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.jobQueueRun.create({
          data: {
            jobId: 'smuggled.job',
            eventName: 'smuggled',
            workspaceId: fx.workspaceW2Id,
            runAt: new Date(),
            maxAttempts: 1,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);

    // And it really did not land — read back as the owner, so "refused" is a
    // statement about the row rather than about what the app role can see.
    const leaked = await adminDb.jobQueueRun.findFirst({ where: { jobId: 'smuggled.job' } });
    expect(leaked).toBeNull();
  });

  it('a tenant CANNOT re-tenant its own run onto another workspace', async () => {
    const fx = await makeFixture();
    await expect(
      asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
        tx.jobQueueRun.update({
          where: { id: fx.runW1Id },
          data: { workspaceId: fx.workspaceW2Id },
        }),
      ),
    ).rejects.toThrow(/row-level security/i);

    const still = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: fx.runW1Id } });
    expect(still.workspaceId).toBe(fx.workspaceW1Id);
  });

  it('the system-admin branch CAN insert an untenanted run — the trusted writer', async () => {
    await makeFixture();
    // The mirror of the test above: the policy is not "deny writes", it is
    // "deny writes outside your context", and the runtime's context is
    // system-admin precisely because a job may belong to no workspace.
    const created = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.jobQueueRun.create({
        data: {
          jobId: 'system.rate-limit-sweep',
          eventName: 'scheduled.system.rate-limit-sweep',
          runAt: new Date(),
          maxAttempts: 5,
        },
      }),
    );
    expect(created.workspaceId).toBeNull();
  });

  it('a tenant cannot UPDATE or DELETE another tenant’s run', async () => {
    const fx = await makeFixture();
    // A row the policy hides is a row that does not exist for UPDATE/DELETE, so
    // the denial surfaces as a zero count rather than an error.
    const updated = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.jobQueueRun.updateMany({
        where: { id: fx.runW2Id },
        data: { state: 'cancelled' },
      }),
    );
    expect(updated.count).toBe(0);

    const deleted = await asAppRole({ workspaceId: fx.workspaceW1Id }, (tx) =>
      tx.jobQueueRun.deleteMany({ where: { id: fx.runW2Id } }),
    );
    expect(deleted.count).toBe(0);

    const survivor = await adminDb.jobQueueRun.findUniqueOrThrow({ where: { id: fx.runW2Id } });
    expect(survivor.state).toBe('pending');
  });
});

describe('the job engine tables — referential cascades', () => {
  it('deleting an EVENT removes its runs and their steps', async () => {
    const fx = await makeFixture();
    await adminDb.jobEvent.delete({ where: { id: fx.eventW1Id } });

    expect(await adminDb.jobQueueRun.findUnique({ where: { id: fx.runW1Id } })).toBeNull();
    expect(await adminDb.jobStep.findUnique({ where: { id: fx.stepW1Id } })).toBeNull();
    // The other tenant's chain is untouched — the cascade follows the FK, not
    // the table.
    expect(await adminDb.jobQueueRun.findUnique({ where: { id: fx.runW2Id } })).not.toBeNull();
  });

  it('deleting a WORKSPACE removes its events, runs and steps', async () => {
    const fx = await makeFixture();
    await adminDb.workspace.delete({ where: { id: fx.workspaceW1Id } });

    expect(await adminDb.jobEvent.findUnique({ where: { id: fx.eventW1Id } })).toBeNull();
    expect(await adminDb.jobQueueRun.findUnique({ where: { id: fx.runW1Id } })).toBeNull();
    expect(await adminDb.jobStep.findUnique({ where: { id: fx.stepW1Id } })).toBeNull();
    // The untenanted system chain SURVIVES a tenant delete, which is the point
    // of the nullable column: a system job is nobody's tenant data.
    expect(await adminDb.jobEvent.findUnique({ where: { id: fx.eventSystemId } })).not.toBeNull();
    expect(await adminDb.jobQueueRun.findUnique({ where: { id: fx.runSystemId } })).not.toBeNull();
  });
});

describe('the claim index actually serves the claim query', () => {
  it('the pending/due claim is planned as an index scan on (state, run_at), with no sort', async () => {
    const fx = await makeFixture();
    // Enough rows that the planner has a reason to prefer the index; a seq scan
    // over three rows would be correct and would prove nothing.
    //
    // ⚠️ THEY MUST BE DUE — `runAt` in the PAST. An earlier version of this test
    // seeded `Date.now() + i * 1000`, so all 400 rows were in the FUTURE and the
    // predicate matched only the three the fixture had seeded. The planner
    // estimated `rows=2`, chose a Bitmap Index Scan (which does not preserve
    // order) and a Sort — and the assertion below failed for a reason that had
    // nothing to do with the index. A plan test is only as good as the
    // distribution it plans against.
    const base = Date.now();
    await adminDb.jobQueueRun.createMany({
      data: Array.from({ length: 400 }, (_, i) => ({
        jobId: `bulk.job.${i}`,
        eventName: 'bulk',
        workspaceId: fx.workspaceW1Id,
        runAt: new Date(base - (i + 1) * 1000),
        maxAttempts: 3,
      })),
    });
    await adminDb.$executeRawUnsafe('ANALYZE "job_queue"');

    const plan = await adminDb.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
      `EXPLAIN SELECT id FROM "job_queue"
        WHERE state = 'pending' AND run_at <= (now() AT TIME ZONE 'UTC')
        ORDER BY run_at
        LIMIT 10`,
    );
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');

    // The index earns its place two ways, and both matter: it locates the due
    // rows, AND it supplies the ordering, so the claim never sorts the queue to
    // take ten rows off the front.
    expect(text).toContain('job_queue_state_run_at_idx');
    expect(text).not.toMatch(/\bSort\b/);
  });
});
