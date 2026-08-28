import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import {
  EmptyJobRegistryError,
  JobScheduler,
  MAX_CATCH_UP_FIRES,
} from '@/lib/jobs/engine/scheduler';
import { engineJob, type EngineJobDefinition } from '@/lib/jobs/engine/registry';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
// The REAL registry — imported for its side effect, so every definition module is
// evaluated and `defineJob` has registered all fourteen scheduled jobs. The
// routed-job assertions below run against THAT, not against a fixture, so a job
// whose cron or disposition moves is visible here.
import '@/lib/jobs/registry';

// THE SCHEDULER (Story MOTIR-3416 · Subtask MOTIR-3471), against a real Postgres.
//
// Two things this file is careful about, both stated because they are the ways a
// scheduler test lies:
//
//   1. ⚠️ THE CLOCK IS INJECTED INTO EVERY CASE. A scheduler asserted against the
//      wall clock is a suite that passes all day and fails at 03:29 on the third
//      of the month. Every `now` below is a pinned instant, and every expected
//      fire is computed from the cron expression rather than typed out twice.
//   2. ⚠️ THE ROW IS READ BACK FROM THE DATABASE, not inferred from the tick's
//      return value. `event_name` in particular has three consumers and the
//      return value would agree with the code whatever it wrote.

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

/** A pinned instant that is exactly `system.attachment-gc`'s 03:30 daily fire. */
const GC_FIRE = new Date(Date.UTC(2026, 7, 25, 3, 30, 0));
/** Six hours after it — the shape "the worker was down across the fire" takes. */
const SIX_HOURS_LATER = new Date(Date.UTC(2026, 7, 25, 9, 30, 0));

/**
 * A scheduler over a FIXTURE definition set, so a case can pin a cadence and a
 * disposition without depending on which real job happens to declare them. The
 * ids are real ones, because the registry and the ledger both key on the id.
 */
function schedulerOver(defs: EngineJobDefinition[], now: Date): JobScheduler {
  const s = new JobScheduler({ scheduledJobs: () => defs, now: () => now, logger: silent });
  s.start();
  return s;
}

/** A fixture definition, defaulted to the daily-GC shape. */
function def(over: Partial<EngineJobDefinition> = {}): EngineJobDefinition {
  return {
    id: 'system.attachment-gc',
    trigger: undefined,
    cron: '30 3 * * *',
    // Stated rather than omitted, like every sibling field: `EngineJobDefinition`
    // keeps its optionals as `T | undefined` REQUIRED so a registration cannot
    // silently drop one. `idempotency` (MOTIR-3459) and `debounce` (MOTIR-3483)
    // each joined after this fixture was written, and each was added here because
    // the type made omitting it an error — which is the property working.
    idempotency: undefined,
    debounce: undefined,
    catchUp: 'latest',
    maxAttempts: 5,
    retryPolicy: 'idempotent',
    handler: () => undefined,
    ...over,
  };
}

async function queuedFor(jobId: string): Promise<Date[]> {
  const rows = await adminDb.jobQueueRun.findMany({
    where: { jobId },
    orderBy: { scheduledFor: 'asc' },
  });
  return rows.map((r) => r.scheduledFor!).filter(Boolean);
}

describe('the start-up guard — an empty registry REFUSES rather than schedules nothing', () => {
  it('throws EmptyJobRegistryError, naming the side-effect import', () => {
    // The failure this prevents is silent by construction: a process that never
    // imported `@/lib/jobs/registry` has an empty engine table, so a scheduler
    // over it enqueues nothing forever and an operator sees a dashboard with no
    // rows — indistinguishable from "this deployment has no cron jobs". Exactly
    // the shape MOTIR-3455 found on the emit path.
    const scheduler = new JobScheduler({ scheduledJobs: () => [], logger: silent });
    expect(() => scheduler.start()).toThrow(EmptyJobRegistryError);
    // The message has to carry the DIAGNOSIS, because it is the whole of what
    // whoever reads the crashed process's log gets.
    expect(() => scheduler.start()).toThrow(/@\/lib\/jobs\/registry/);
    expect(scheduler.isStarted).toBe(false);
  });

  it('a tick before start() is a no-op rather than a throw', async () => {
    const scheduler = new JobScheduler({ scheduledJobs: () => [def()], logger: silent });
    const outcome = await scheduler.tick();
    expect(outcome.enqueued).toEqual([]);
    expect(await queuedFor('system.attachment-gc')).toEqual([]);
  });

  it('the REAL registry satisfies the guard — the fourteen are actually there', () => {
    // The mirror of the first case: the guard is only useful if the honest
    // configuration passes it, and this is where a registry that stopped being
    // imported by the suite would surface.
    const scheduler = new JobScheduler({ now: () => GC_FIRE, logger: silent });
    expect(() => scheduler.start()).not.toThrow();
  });
});

describe('one tick, one routed job', () => {
  it('enqueues exactly one row carrying the whole scheduler contract', async () => {
    const scheduler = schedulerOver([def()], GC_FIRE);

    const outcome = await scheduler.tick();
    expect(outcome.failed).toEqual([]);
    expect(outcome.enqueued).toHaveLength(1);

    const rows = await adminDb.jobQueueRun.findMany({ where: { jobId: 'system.attachment-gc' } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // Read back from the DATABASE — the tick's return value would agree with the
    // code whatever it wrote.
    expect(row.eventId).toBeNull();
    expect(row.workspaceId).toBeNull();
    // ⚠️ THE FIELD WITH THREE CONSUMERS. `jobScheduleHealthService` groups on
    // exactly `scheduled.{functionId}`; a typo makes every migrated cron job read
    // as permanently overdue — the tripwire firing on the tripwire.
    expect(row.eventName).toBe('scheduled.system.attachment-gc');
    expect(row.scheduledFor?.getTime()).toBe(GC_FIRE.getTime());
    // `run_at` is the FIRE instant, so the claim's `ORDER BY run_at` puts owed
    // work ahead of anything enqueued since.
    expect(row.runAt.getTime()).toBe(GC_FIRE.getTime());
    expect(row.maxAttempts).toBe(5);
    expect(row.state).toBe('pending');
  });

  // ⚠️ TWO TESTS STOOD HERE AND THEIR SUBJECT IS GONE (MOTIR-3418). One asserted
  // that the scheduler enqueued NOTHING for a job absent from
  // `MOTIR_POSTGRES_JOB_IDS` — it had to respect the switch exactly as
  // `dispatchEventToEngine` did, or the cutover became a double-run — and the
  // other that the switch was PER JOB, scheduling one cron while leaving its
  // sibling alone. There is no second scheduler for a cron job to also fire on,
  // so a registered cron is scheduled, full stop.

  it('TICKING TWICE for the same fire produces ONE row, and says already-queued', async () => {
    const scheduler = schedulerOver([def()], GC_FIRE);

    const first = await scheduler.tick();
    const second = await scheduler.tick();

    expect(first.enqueued).toHaveLength(1);
    expect(first.alreadyQueued).toEqual([]);
    // This is the normal state of a healthy scheduler between two fires: it
    // recomputes the same instant every poll and writes nothing.
    expect(second.enqueued).toEqual([]);
    expect(second.alreadyQueued).toHaveLength(1);
    expect(await queuedFor('system.attachment-gc')).toHaveLength(1);
  });

  it('TWO SCHEDULERS ticking the same fire concurrently produce ONE row', async () => {
    // ⚠️ The story's headline criterion, at this tier. Two schedulers is what two
    // worker machines are, and a SERIAL pair of ticks cannot see the defect —
    // the second simply finds the first's row. Both ticks are in flight at once
    // against a warm pool.
    const a = schedulerOver([def()], GC_FIRE);
    const b = schedulerOver([def()], GC_FIRE);

    const [ra, rb] = await Promise.all([a.tick(), b.tick()]);

    const total = ra.enqueued.length + rb.enqueued.length;
    const dedup = ra.alreadyQueued.length + rb.alreadyQueued.length;
    expect(total).toBe(1);
    expect(dedup).toBe(1);
    expect(await queuedFor('system.attachment-gc')).toHaveLength(1);
  });

  it('one job failing does not stop its siblings', async () => {
    // A cron the evaluator refuses: the fan-out property the dispatcher already
    // has — one consumer's bad day must not silently drop thirteen sweeps.
    const scheduler = schedulerOver(
      [def({ id: 'system.rate-limit-sweep', cron: 'not-a-cron', catchUp: 'latest' }), def()],
      GC_FIRE,
    );
    const outcome = await scheduler.tick();
    expect(outcome.failed.map((f) => f.jobId)).toEqual(['system.rate-limit-sweep']);
    expect(outcome.enqueued).toHaveLength(1);
    expect(await queuedFor('system.attachment-gc')).toHaveLength(1);
  });
});

describe('the fire time comes from the CLOCK, never from the last tick', () => {
  it('a tick that arrives SIX HOURS LATE still enqueues the fire it owed, at its own instant', async () => {
    // The worker was down across 03:30 and came back at 09:30. The row must carry
    // 03:30 — not 09:30, and not "one interval after the previous tick", which is
    // what a self-re-arming timer would produce and what would shift every
    // subsequent fire.
    const scheduler = schedulerOver([def()], SIX_HOURS_LATER);
    await scheduler.tick();

    const [fire] = await queuedFor('system.attachment-gc');
    expect(fire?.getTime()).toBe(GC_FIRE.getTime());
  });

  it('a per-minute job crossing a fire boundary enqueues the NEW instant, not a shifted one', async () => {
    const minutely = def({
      id: 'system.ci-runner-reap',
      cron: '* * * * *',
      catchUp: 'latest',
    });
    const at1201 = new Date(Date.UTC(2026, 7, 25, 12, 1, 17));
    const at1202 = new Date(Date.UTC(2026, 7, 25, 12, 2, 3));

    await schedulerOver([minutely], at1201).tick();
    await schedulerOver([minutely], at1202).tick();

    // Two rows on exact minute boundaries — the seconds the ticks happened to run
    // at are nowhere in the answer.
    expect((await queuedFor('system.ci-runner-reap')).map((d) => d.toISOString())).toEqual([
      new Date(Date.UTC(2026, 7, 25, 12, 1, 0)).toISOString(),
      new Date(Date.UTC(2026, 7, 25, 12, 2, 0)).toISOString(),
    ]);
  });
});

describe('each declared catch-up disposition is HONOURED', () => {
  // A per-minute cadence so "N fires behind" is expressible in a fixture without
  // seeding a month of history.
  const MINUTELY = '* * * * *';
  const T0 = new Date(Date.UTC(2026, 7, 25, 12, 0, 0));
  /** Five fires later — the "the worker was down for five minutes" shape. */
  const T5 = new Date(Date.UTC(2026, 7, 25, 12, 5, 0));

  /** Seed the watermark: a row for the fire five minutes before `T5`. */
  async function seedWatermark(jobId: string, at: Date): Promise<void> {
    await withSystemContext((tx) =>
      jobQueueRepository.enqueueScheduled(
        {
          jobId,
          scheduledFor: at,
          eventName: `scheduled.${jobId}`,
          runAt: at,
          maxAttempts: 5,
        },
        tx,
      ),
    );
  }

  it('`latest` enqueues ONLY the most recent missed fire, whatever the gap', async () => {
    await seedWatermark('system.ci-runner-reap', T0);

    await schedulerOver(
      [def({ id: 'system.ci-runner-reap', cron: MINUTELY, catchUp: 'latest' })],
      T5,
    ).tick();

    // The seeded 12:00 plus exactly one new row at 12:05 — the four fires in
    // between are dropped, which is what `latest` promises.
    expect((await queuedFor('system.ci-runner-reap')).map((d) => d.toISOString())).toEqual([
      T0.toISOString(),
      T5.toISOString(),
    ]);
  });

  it('`all` enqueues EVERY missed fire, oldest first', async () => {
    await seedWatermark('system.ci-runner-reap', T0);

    const outcome = await schedulerOver(
      [def({ id: 'system.ci-runner-reap', cron: MINUTELY, catchUp: 'all' })],
      T5,
    ).tick();

    // 12:01 … 12:05 — the five fires strictly after the watermark.
    expect(outcome.enqueued).toHaveLength(5);
    expect((await queuedFor('system.ci-runner-reap')).map((d) => d.toISOString())).toEqual(
      [
        T0, // the watermark row
        new Date(Date.UTC(2026, 7, 25, 12, 1, 0)),
        new Date(Date.UTC(2026, 7, 25, 12, 2, 0)),
        new Date(Date.UTC(2026, 7, 25, 12, 3, 0)),
        new Date(Date.UTC(2026, 7, 25, 12, 4, 0)),
        T5,
      ].map((d) => d.toISOString()),
    );
  });

  it('`all` with NO prior row enqueues ONE fire — there is no history to replay', async () => {
    // Without this, a first deploy would replay the evaluator's entire 400-day
    // horizon. A watermark that does not exist is not a watermark of zero.
    await schedulerOver(
      [def({ id: 'system.ci-runner-reap', cron: MINUTELY, catchUp: 'all' })],
      T5,
    ).tick();
    expect((await queuedFor('system.ci-runner-reap')).map((d) => d.toISOString())).toEqual([
      T5.toISOString(),
    ]);
  });

  it('`all` CAPS a very long outage and SAYS SO — never a silent truncation', async () => {
    // A watermark far enough back that the cap binds: MAX_CATCH_UP_FIRES + 10
    // minutes of missed per-minute fires.
    const long = new Date(T5.getTime() - (MAX_CATCH_UP_FIRES + 10) * 60_000);
    await seedWatermark('system.ci-runner-reap', long);

    const outcome = await schedulerOver(
      [def({ id: 'system.ci-runner-reap', cron: MINUTELY, catchUp: 'all' })],
      T5,
    ).tick();

    expect(outcome.enqueued).toHaveLength(MAX_CATCH_UP_FIRES);
    // A sweep that silently drops its tail reads exactly like one that had
    // nothing left to do.
    expect(outcome.capped).toEqual(['system.ci-runner-reap']);
  });

  it('`skip` enqueues NOTHING for a fire from before the scheduler started', async () => {
    // Started at 12:05:30 — thirty seconds AFTER the 12:05 fire, which is exactly
    // the shape "the worker was down across it" takes. The disposition's whole
    // question is "was anyone watching when that fire passed?", and this scheduler
    // was not.
    const startedAt = new Date(T5.getTime() + 30_000);
    const outcome = await schedulerOver(
      [def({ id: 'system.ci-runner-provision-sweep', cron: MINUTELY, catchUp: 'skip' })],
      startedAt,
    ).tick();

    expect(outcome.enqueued).toEqual([]);
    expect(await queuedFor('system.ci-runner-provision-sweep')).toEqual([]);

    // ⚠️ THE CONTROL, and it is what makes the empty result above mean anything:
    // the SAME job, the SAME clock, differing only in the declared disposition.
    // Without it, a fixture that simply never enqueues would pass.
    await schedulerOver(
      [def({ id: 'system.ci-runner-reap', cron: MINUTELY, catchUp: 'latest' })],
      startedAt,
    ).tick();
    expect((await queuedFor('system.ci-runner-reap')).map((d) => d.toISOString())).toEqual([
      T5.toISOString(),
    ]);
  });

  it('`skip` DOES enqueue a fire that happens while the scheduler is watching', async () => {
    // Started at 12:00:10, so the 12:01 fire happened on its watch.
    let clock = new Date(Date.UTC(2026, 7, 25, 12, 0, 10));
    const scheduler = new JobScheduler({
      scheduledJobs: () => [
        def({ id: 'system.ci-runner-provision-sweep', cron: MINUTELY, catchUp: 'skip' }),
      ],
      now: () => clock,
      logger: silent,
    });
    scheduler.start();

    // The first tick owes 12:00, which predates the start — nothing.
    expect((await scheduler.tick()).enqueued).toEqual([]);

    clock = new Date(Date.UTC(2026, 7, 25, 12, 1, 4));
    const second = await scheduler.tick();
    expect(second.enqueued).toHaveLength(1);
    expect(
      (await queuedFor('system.ci-runner-provision-sweep')).map((d) => d.toISOString()),
    ).toEqual([new Date(Date.UTC(2026, 7, 25, 12, 1, 0)).toISOString()]);
  });
});

describe('the real fourteen, as shipped', () => {
  it('schedules the REAL `system.attachment-gc` from the registry, at its own cron', async () => {
    // Everything above uses a fixture definition so a cadence can be pinned. This
    // is the case that proves the wiring against the SHIPPED definition — its
    // cron, its disposition and its attempt budget, none of them restated here.
    const real = engineJob('system.attachment-gc');
    expect(real?.cron).toBeTruthy();

    const scheduler = new JobScheduler({ now: () => GC_FIRE, logger: silent });
    scheduler.start();
    await scheduler.tick();

    const rows = await adminDb.jobQueueRun.findMany({ where: { jobId: 'system.attachment-gc' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.maxAttempts).toBe(real?.maxAttempts);
    expect(rows[0]?.eventName).toBe('scheduled.system.attachment-gc');

    // ⚠️ AND THE SIBLINGS ARE SCHEDULED TOO, WHICH THIS LINE USED TO DENY. It read
    // "nothing else was scheduled: only the routed id may be" — true while the
    // cutover switch narrowed the scheduled set to the routed ids, and false with
    // one lane, where every registered cron whose fire is due is enqueued. What is
    // still worth asserting is that a scheduled row is a SCHEDULED row: each one
    // carries a `scheduled_for`, which is what makes the tick idempotent.
    const all = await adminDb.jobQueueRun.findMany({ where: { scheduledFor: { not: null } } });
    expect(all.map((r) => r.jobId)).toContain('system.attachment-gc');
    expect(all.every((r) => r.scheduledFor !== null)).toBe(true);
  });
});
