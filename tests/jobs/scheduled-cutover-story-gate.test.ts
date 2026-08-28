import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { defineJob } from '@/lib/jobs/defineJob';
import { JobWorker } from '@/lib/jobs/engine/worker';
import { JobScheduler } from '@/lib/jobs/engine/scheduler';
import { executeWithLedger, recordEngineTerminalFailure } from '@/lib/jobs/engine/ledger';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { engineScheduledJobs, type EngineJobDefinition } from '@/lib/jobs/engine/registry';
import { jobSchedules } from '@/lib/jobs/schedules';
import { CATCH_UP_POLICY_NAMES, type CatchUpPolicy } from '@/lib/jobs/catchUp';
import { jobScheduleHealthService } from '@/lib/services/jobScheduleHealthService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
// The REAL registry, for its side effect — every definition module evaluated, so
// the totality guards below walk the shipped set rather than a fixture.
import '@/lib/jobs/registry';

// THE STORY GATE for the SCHEDULED cutover (Story MOTIR-3416 · Subtask MOTIR-3472).
//
// It is NOT a second copy of the per-subtask units. MOTIR-3469 owns the
// constraint, MOTIR-3470 owns the declaration and its registry-totality walk,
// MOTIR-3471 owns the tick. This file does the three things none of those can:
//
//   §1 THE BRANCH TOP-UP — the arms of the story's own new code that no
//      per-subtask case reaches. Each was SORTED before it was written: a
//      coverage zero measures execution and says nothing about reachability, so
//      "nobody tested this" and "nothing can test this" produce the same cell.
//      Every one below is reachable, so each gets a test rather than an ignore.
//
//   §2 THE INTEGRATION SEAMS — the joins the units mock at one end. A tick's row
//      travelling through a REAL claim into the REAL ledger; a scheduled run that
//      throws reaching the REAL dead-letter path through the worker's settle
//      path; the declaration reaching the reader.
//
//   §3 THE ARCHITECTURE AND TOTALITY GUARDS — what a percentage cannot see. Two
//      workers not double-firing a tick, a routed cron job declining to also run
//      on Inngest, the fourteen schedule constants, and the schedule-health probe
//      still judging a migrated job.
//
// Real Postgres throughout, no mocks.

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

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** A fixture scheduled definition. The ids are real ones — routing keys on them. */
function def(over: Partial<EngineJobDefinition> = {}): EngineJobDefinition {
  return {
    id: 'system.attachment-gc',
    trigger: undefined,
    cron: '* * * * *',
    // Stated rather than omitted, like every sibling field: `EngineJobDefinition`
    // keeps its optionals as `T | undefined` REQUIRED so a registration cannot
    // silently drop one. `idempotency` (MOTIR-3459) and `debounce` (MOTIR-3483)
    // each joined after this fixture was written, and each was added here because
    // the type made omitting it an error — which is the property working.
    idempotency: undefined,
    debounce: undefined,
    catchUp: 'latest',
    maxAttempts: 3,
    retryPolicy: 'transient',
    handler: () => undefined,
    ...over,
  };
}

/**
 * ⚠️ EVERY `defineJob` BELOW REGISTERS A SYNTHETIC ID, NEVER A REAL ONE.
 * `registerEngineJob` OVERWRITES by id and the registry is MODULE state, so
 * redefining `system.attachment-gc` here would replace the shipped definition's
 * cron and retry budget — for this file, and for every later file sharing the
 * worker. The first draft of this suite did exactly that and its own
 * schedule-constant guard caught it, which is the guard working.
 */
let seq = 0;
function gateJobId(): string {
  seq += 1;
  return `gate.scheduled.${seq}`;
}

function schedulerOver(defs: EngineJobDefinition[], now: Date): JobScheduler {
  const s = new JobScheduler({ scheduledJobs: () => defs, now: () => now, logger: silent });
  s.start();
  return s;
}

const FIRE = new Date(Date.UTC(2026, 7, 25, 12, 0, 0));

// ═══════════════════════════════════════════════════════════════════════════
// §1 — THE BRANCH TOP-UP
// ═══════════════════════════════════════════════════════════════════════════

describe('§1 the arms of the story’s own code nothing else reaches', () => {
  it('defaults its clock and its logger when neither is injected', () => {
    // Every case in `engine-scheduler.test.ts` injects both, deliberately — a
    // scheduler asserted against the wall clock fails at 03:29 on the third of the
    // month. That leaves the two production defaults unexecuted, and they are the
    // ones the real worker actually runs.
    const scheduler = new JobScheduler({ scheduledJobs: () => [def()] });
    const before = Date.now();
    scheduler.start();
    // `start()` stamps `watchingSince` from the default clock, so a scheduler that
    // started is proof the default `() => new Date()` was called.
    expect(scheduler.isStarted).toBe(true);
    expect(Date.now()).toBeGreaterThanOrEqual(before);
  });

  it('reports a NON-Error throw without losing it', async () => {
    // The `err instanceof Error ? … : String(err)` arm. A throwing property getter
    // is contrived and it is the honest way to reach a defensive branch whose
    // whole point is that the thrown value is not an Error — which nothing in our
    // own code produces and any dependency may.
    const hostile = def();
    Object.defineProperty(hostile, 'cron', {
      get() {
        throw 'a bare string, not an Error';
      },
    });

    const outcome = await schedulerOver([hostile], FIRE).tick();
    expect(outcome.failed).toEqual([
      { jobId: 'system.attachment-gc', error: 'a bare string, not an Error' },
    ]);
    expect(outcome.enqueued).toEqual([]);
  });

  it('SKIPS a definition in the scheduled set that carries no cron or no disposition', async () => {
    // `scheduledJobs` is injectable and `EngineJobDefinition` types both fields as
    // optional, so an event-triggered definition CAN reach this loop. It must be
    // ignored rather than scheduled at an invented instant.
    const outcome = await schedulerOver(
      [def({ cron: undefined }), def({ id: 'system.rate-limit-sweep', catchUp: undefined })],
      FIRE,
    ).tick();
    expect(outcome.enqueued).toEqual([]);
    expect(await adminDb.jobQueueRun.count()).toBe(0);
  });

  it('owes NOTHING for an expression that never fires inside the search horizon', async () => {
    // `0 0 30 2 *` — the thirtieth of February. `parseCron` accepts it (both
    // fields are in range) and `previousFireAtOrBefore` returns null after walking
    // its whole horizon. Nothing is owed, and nothing is written; the alternative
    // is a crash on a legal expression.
    const outcome = await schedulerOver([def({ cron: '0 0 30 2 *' })], FIRE).tick();
    expect(outcome.enqueued).toEqual([]);
    expect(outcome.failed).toEqual([]);
    expect(await adminDb.jobQueueRun.count()).toBe(0);
  });

  it('enqueueScheduled RETHROWS anything that is not a unique violation', async () => {
    // The mirror of the already-queued arm. `P2002` means "this tick is queued";
    // everything else is a real failure and must not be silently reported as a
    // successful dedup, which would make a broken database look like a healthy
    // scheduler.
    await expect(
      withSystemContext((tx) =>
        jobQueueRepository.enqueueScheduled(
          {
            jobId: 'system.attachment-gc',
            // An invalid Date reaches Prisma as a value it refuses — a genuine
            // non-unique failure rather than a stubbed one.
            scheduledFor: new Date('not a date'),
            eventName: 'scheduled.system.attachment-gc',
            runAt: FIRE,
            maxAttempts: 3,
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
    expect(await adminDb.jobQueueRun.count()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 — THE INTEGRATION SEAMS
// ═══════════════════════════════════════════════════════════════════════════

describe('§2a the seam — scheduler → repository → claim → ledger', () => {
  it('a tick’s row becomes a job_run carrying `scheduled.<id>`, with no fake at either end', async () => {
    // ⚠️ `event_name` is the field THREE consumers read and no unit test of the
    // scheduler alone can prove, because the scheduler's own assertion would agree
    // with the scheduler's own code. This drives a real tick, a real claim and the
    // real ledger wrapper, and reads the LEDGER row back.
    const jobId = gateJobId();
    const handled: string[] = [];
    // A SYNTHETIC id (see the helper's warning) — the runner resolves the handler
    // by id, so a fixture proves the seam exactly as a shipped job would, without
    // overwriting one.
    defineJob({ id: jobId as never, cron: '* * * * *', catchUp: 'latest' }, () => {
      handled.push(jobId);
      return { swept: 0 };
    });

    await schedulerOver([def({ id: jobId })], FIRE).tick();

    const worker = new JobWorker({
      workerId: 'seam-worker',
      logger: silent,
      execute: async (run) => {
        await executeWithLedger(run, {});
      },
    });
    expect(await worker.tick()).toBe(1);
    expect(handled).toEqual([jobId]);

    const ledger = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.eventName).toBe(`scheduled.${jobId}`);
    expect(ledger[0]?.status).toBe('succeeded');
    expect(ledger[0]?.workspaceId).toBeNull();
    // And the queue row settled — a scheduled run is an ordinary row from the
    // moment it is written, which is the story's whole scope argument.
    const queued = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId } });
    expect(queued.state).toBe('succeeded');
    expect(queued.scheduledFor?.getTime()).toBe(FIRE.getTime());
  });
});

describe('§2b a SCHEDULED run that throws reaches the DLQ and is replayable', () => {
  it('exhausts its budget and writes both the failed ledger row and the dead-letter row', async () => {
    // ⚠️ DRIVEN THROUGH THE WORKER'S SETTLE PATH, not around it.
    // `lib/jobs/engine/ledger.ts` explains at length why this write is easy to
    // APPEAR to test and not have: an in-process harness that runs a catch
    // synchronously made the original Inngest bug look fixed when it was not
    // (PRODECT_FINDINGS #39). The hook here is the loop's, so the assertion is
    // about the loop.
    const jobId = gateJobId();
    defineJob({ id: jobId as never, cron: '* * * * *', catchUp: 'latest', retries: 0 }, () => {
      throw new Error('the sweep exploded');
    });

    await schedulerOver([def({ id: jobId, maxAttempts: 1 })], FIRE).tick();

    const worker = new JobWorker({
      workerId: 'dlq-worker',
      logger: silent,
      execute: async (run) => {
        await executeWithLedger(run, {});
      },
      onTerminalFailure: async (run, error) => {
        await recordEngineTerminalFailure(run, error, {});
      },
    });
    await worker.tick();

    const queued = await adminDb.jobQueueRun.findFirstOrThrow({ where: { jobId } });
    expect(queued.state).toBe('failed');

    const dlq = await adminDb.jobRunDlq.findMany({ where: { functionId: jobId } });
    expect(dlq).toHaveLength(1);
    // The dead-letter row carries the scheduled provenance, so an operator
    // replaying it knows which tick it was.
    expect(dlq[0]?.eventName).toBe(`scheduled.${jobId}`);
    expect(JSON.stringify(dlq[0]?.failure)).toContain('the sweep exploded');

    const ledger = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.status).toBe('failed');
  });
});

describe('§2c the declared disposition reaches the tick', () => {
  it('each of the declared policies produces the row set it names', async () => {
    // The declaration (MOTIR-3470) and the reader (MOTIR-3471) are two cards. This
    // is the seam between them, asserted for EACH policy in the vocabulary.
    //
    // ⚠️ IT USED TO EXERCISE ONLY THE POLICIES THE REGISTRY HAPPENED TO DECLARE,
    // guarded by `expect(declared.size).toBeGreaterThan(1)` so that a narrowing
    // was noticed rather than silent. It was noticed: MOTIR-3314 clustered the
    // crons, which made `skip`'s rationale false for the one job that held it
    // (that rationale was "the next fire is at most 60 seconds away"), so all
    // fourteen are now `latest` and the set collapsed to one.
    //
    // The tripwire did its job, and the answer is not to keep a disposition alive
    // to satisfy it. This seam belongs to the ENGINE, not to the product's current
    // opinion about which sweeps want which policy — the loop body already builds
    // a SYNTHETIC definition per policy, so it never needed a real job carrying
    // one. Reading the vocabulary instead makes the coverage strictly larger: it
    // now exercises `all`, which no job has ever declared (§11.5 keeps it for the
    // class it names) and which this test consequently never ran.
    //
    // What is still read off the registry is the direction that can actually rot:
    // every disposition a real job declares must be one the engine has a branch
    // for.
    const declared = new Set(engineScheduledJobs().map((d) => d.catchUp));
    for (const policy of declared) expect(CATCH_UP_POLICY_NAMES).toContain(policy);

    const policies: CatchUpPolicy[] = [...CATCH_UP_POLICY_NAMES];
    expect(policies).toHaveLength(3);

    const T0 = new Date(Date.UTC(2026, 7, 25, 12, 0, 0));
    const T3 = new Date(Date.UTC(2026, 7, 25, 12, 3, 0));

    for (const policy of policies) {
      await truncateJobRuns();
      const jobId = 'system.attachment-gc';
      // Seed a watermark three fires back, so "N fires behind" is a real state
      // rather than an empty table.
      await withSystemContext((tx) =>
        jobQueueRepository.enqueueScheduled(
          {
            jobId,
            scheduledFor: T0,
            eventName: `scheduled.${jobId}`,
            runAt: T0,
            maxAttempts: 3,
          },
          tx,
        ),
      );

      // `skip` needs a scheduler that started AFTER the fire it is offered.
      const startedAt = policy === 'skip' ? new Date(T3.getTime() + 30_000) : T3;
      const outcome = await schedulerOver([def({ id: jobId, catchUp: policy })], startedAt).tick();

      const written = await adminDb.jobQueueRun.count({ where: { jobId } });
      if (policy === 'skip') {
        expect(outcome.enqueued, 'skip enqueues nothing').toEqual([]);
        expect(written).toBe(1); // the seeded watermark, and nothing else
      } else if (policy === 'latest') {
        expect(outcome.enqueued, 'latest enqueues exactly one').toHaveLength(1);
        expect(written).toBe(2);
      } else {
        // `all` — 12:01, 12:02, 12:03.
        expect(outcome.enqueued, 'all enqueues every missed fire').toHaveLength(3);
        expect(written).toBe(4);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 — THE ARCHITECTURE AND TOTALITY GUARDS
// ═══════════════════════════════════════════════════════════════════════════

describe('§3a TWO WORKERS DO NOT DOUBLE-FIRE A TICK', () => {
  it('two full worker loops, each with its own scheduler, produce ONE run for one fire', async () => {
    // ⚠️ THE STORY'S HEADLINE CRITERION, at the highest tier it can be asserted:
    // not two `enqueueScheduled` calls (MOTIR-3469 owns that) and not two
    // schedulers in isolation (MOTIR-3471 owns that), but two WORKERS each
    // scheduling and claiming, which is what two machines are.
    //
    // SEQUENTIAL CALLS DO NOT TEST THIS. Both ticks must be in flight at once
    // against one warm pool — the same argument `claimDueRuns`' header makes about
    // its own claim.
    const jobId = gateJobId();
    const executions: string[] = [];
    defineJob({ id: jobId as never, cron: '* * * * *', catchUp: 'latest' }, () => {
      executions.push(jobId);
      return { ok: true };
    });

    const make = (name: string): JobWorker => {
      const scheduler = schedulerOver([def({ id: jobId })], FIRE);
      return new JobWorker({
        workerId: name,
        logger: silent,
        onSchedulerTick: () => scheduler.tick().then(() => undefined),
        execute: async (run) => {
          // A real handler does I/O; the await widens the window in which the
          // other worker could claim the same row.
          await new Promise((r) => setTimeout(r, 5));
          await executeWithLedger(run, {});
        },
      });
    };

    await Promise.all([make('worker-a').tick(), make('worker-b').tick()]);

    // Exactly one queue row for the fire, and exactly one execution of it.
    const queued = await adminDb.jobQueueRun.findMany({ where: { jobId } });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.scheduledFor?.getTime()).toBe(FIRE.getTime());
    expect(executions).toHaveLength(1);
    // And ONE ledger row — a second would mean the job ran twice even if the
    // queue only held one row.
    expect(await adminDb.jobRun.count({ where: { functionId: jobId } })).toBe(1);
  });
});

// ⚠️ §3b STOOD HERE — "a routed CRON job does not ALSO run on Inngest"
// (MOTIR-3418 removed it). It reached inside the built vendor function and
// invoked its handler directly to prove the cutover guard declined a cron
// invocation of a migrated job, with an unrouted CONTROL beside it. There is no
// second engine for a cron job to also run on: `lib/jobs/engine/scheduler.ts` is
// the only thing that turns a cron expression into a run, and §3a above proves
// two schedulers do not double-fire one tick.

describe('§3c the fourteen schedule constants are unchanged', () => {
  it('every registered cron equals the NAMED CONSTANT its definition module exports', async () => {
    // The story promises it changes which ENGINE fires a job and nothing about
    // WHEN. Asserted against the exported constants rather than by inspection, and
    // walked from the registry so a fifteenth job joins the guard automatically.
    //
    // It is a different assertion from MOTIR-3470's ADR agreement: that one proves
    // the record matches the code, this one proves the code still reads its own
    // named constant rather than a literal somebody re-timed in place.
    const modules = import.meta.glob('../../lib/jobs/definitions/*.ts');
    const constants = new Map<string, string>();
    for (const load of Object.values(modules)) {
      const mod = (await load()) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (name.endsWith('_CRON') && typeof value === 'string') constants.set(name, value);
      }
    }
    // ⚠️ FILTERED TO THE SHIPPED `system.*` NAMESPACE, because this suite (and
    // any other) registers synthetic scheduled jobs into the same module-level
    // registry. Filtering is what keeps the COUNT assertion meaningful rather
    // than making it depend on how many fixtures ran first.
    const shipped = engineScheduledJobs().filter((d) => d.id.startsWith('system.'));
    // Fourteen crons across thirteen files — `ciRunnerFleet.ts` declares two,
    // which is the enumeration that was already wrong once.
    expect(shipped).toHaveLength(constants.size);

    const declared = new Set(shipped.map((d) => d.cron));
    for (const [name, value] of constants) {
      expect(declared, `${name} is the cron some registered job actually uses`).toContain(value);
    }
  });

  it('the ENGINE registry and the SCHEDULE table hold the same population', async () => {
    // Two self-registering tables, both populated from `defineJob`, read by two
    // different consumers — the scheduler and the health probe. If they ever
    // disagreed, one of the two would be silently blind to a job. Filtered to the
    // shipped namespace for the reason above.
    const shipped = engineScheduledJobs()
      .map((d) => d.id)
      .filter((id) => id.startsWith('system.'));
    const scheduled = jobSchedules()
      .map((x) => x.functionId)
      .filter((id) => id.startsWith('system.'));
    expect(scheduled.sort()).toEqual(shipped.sort());
  });
});

describe('§3d jobScheduleHealthService still judges a MIGRATED job', () => {
  it('reads a ledger row written by the ENGINE path as healthy, with no change to the probe', async () => {
    // The probe is UNCHANGED by this story, and this is what proves it did not
    // need to change: it groups on `scheduled.{functionId}`, and a run the engine
    // produced carries exactly that. Get the name wrong and every migrated job
    // reads as permanently overdue — the tripwire firing on the tripwire.
    const jobId = gateJobId();
    defineJob({ id: jobId as never, cron: '30 3 * * *', catchUp: 'latest' }, () => ({ swept: 0 }));

    const fire = new Date(Date.UTC(2026, 7, 25, 3, 30, 0));
    await schedulerOver([def({ id: jobId, cron: '30 3 * * *' })], fire).tick();
    const worker = new JobWorker({
      workerId: 'health-worker',
      logger: silent,
      execute: async (run) => {
        await executeWithLedger(run, {});
      },
    });
    await worker.tick();

    // Judged an hour after the fire: one tick has passed, so the job is inside
    // the probe's one-missed-tick tolerance and must read healthy.
    const report = await jobScheduleHealthService.check(new Date(fire.getTime() + 3_600_000));
    const entry = report.entries.find((e) => e.functionId === jobId);
    expect(entry, 'the migrated job is still in the probe’s population').toBeDefined();
    expect(entry?.lastRunAt).not.toBeNull();
    expect(report.overdue.map((e) => e.functionId)).not.toContain(jobId);
  });
});

// ⚠️ §3e STOOD HERE — "the scheduler never touches the Inngest config"
// (MOTIR-3418 removed it). It asserted that a scheduled definition SYNCED exactly
// the four keys it always had, so that `catchUp` — an option describing a
// scheduler the vendor did not have — could not leak into a deployed
// registration for no reader. Nothing is synced anywhere now, and `catchUp` is a
// first-class member of the engine's own registration; the assertion that
// replaces it is in `tests/jobs/engine-units.test.ts`.
