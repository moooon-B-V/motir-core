import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { defineJob } from '@/lib/jobs/defineJob';
import { JOB_RUN_REAP_CRON } from '@/lib/jobs/definitions/jobRunReap';
import { engineJob } from '@/lib/jobs/engine/registry';
import { jobServices } from '@/lib/jobs/services';
import {
  JOB_RUN_ABANDON_AFTER_MS,
  JOB_RUN_ABANDONED_CODE,
  jobRunsService,
} from '@/lib/services/jobRunsService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Bug MOTIR-3683 — ONE FAILED RUN IS ONE LEDGER ROW, AND EVERY ROW NAMES ITS LANE.
//
// The defect, measured on the production ledger on 2026-08-27: 29 rows stranded
// at `running` (the oldest for 25 days) each paired ~36 s later with a `failed`
// row for the same function whose `event_id` was the EMPTY STRING — matching
// neither the engine's cuid nor Inngest's ULID, so counted as neither lane by
// every audit the Inngest migration is verified with.
//
// One cause. On the Inngest lane the run handler and `onFailure` each derive the
// correlation key themselves, and for a CRON trigger they derived different
// things: the handler had the scheduled event's real ULID, while `onFailure`'s
// nested original event carries `id: ''`. `??` treats `''` as present, so the
// failure looked up a key nothing had, missed the `running` row, and CREATED a
// second one.
//
// Three groups below, in the order the criteria ask for them: the correlation
// itself, the lane, and the reap that closes what no completion write will reach.

const silentStep = { run: async (_id: string, fn: () => unknown) => fn() };

/** Invoke the `onFailure` Inngest wired onto a `defineJob` function, as Inngest would. */
function invokeOnFailure(
  fn: unknown,
  args: { event: { id?: string; name?: string; data?: unknown }; runId: string; error: Error },
): Promise<unknown> {
  const onFailure = (fn as { opts: { onFailure: (a: unknown) => Promise<unknown> } }).opts
    .onFailure;
  return onFailure({
    event: { data: { run_id: args.runId, event: args.event } },
    error: args.error,
    step: silentStep,
  });
}

let seq = 0;
function nextId(): string {
  seq += 1;
  return `ledger-integrity-${seq}`;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1 · THE CORRELATION — one logical run, one row.
// ─────────────────────────────────────────────────────────────────────────────

describe('a CRON run that fails writes ONE row, not two', () => {
  it('keys both sides on the RUN id, so an empty event id cannot orphan the running row', async () => {
    // The exact production shape. `runId` is what BOTH invocations hold; the
    // scheduled event's own ULID reaches only the handler, and the failure
    // payload's copy of that event carries `id: ''`.
    const jobId = nextId();
    const runId = '01M0YMRDM06V506AKWKBSC5D0Q';
    const fn = defineJob(
      { id: jobId as never, cron: '0 9 * * *', catchUp: 'skip', retryPolicy: 'none' },
      () => {
        throw new Error('the check exploded');
      },
    );

    // What the run handler wrote (the memoized `job-run:start` step).
    await jobRunsService.recordStart({
      workspaceId: null,
      functionId: jobId,
      eventName: `scheduled.${jobId}`,
      eventId: runId,
      lane: 'inngest',
      attempt: 0,
    });

    await invokeOnFailure(fn, {
      // ⚠️ `id: ''` IS THE BUG, reproduced verbatim. Before the fix this made the
      // correlation look up `''`, find nothing, and insert a second row.
      event: { id: '', name: `scheduled.${jobId}`, data: {} },
      runId,
      error: new Error('the check exploded'),
    });

    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    // And the surviving row is attributable: not `''`.
    expect(rows[0]!.eventId).toBe(runId);
  });

  it('an EVENT-triggered run still correlates on the event id, not the run id', async () => {
    // The other arm, and the reason the cron branch is a branch rather than a
    // blanket switch to the run id: for an event-triggered job `original.id` IS
    // populated, and the event id is the more useful thing to record.
    const jobId = nextId();
    const fn = defineJob({ id: jobId as never, retryPolicy: 'none' }, () => {
      throw new Error('boom');
    });

    await jobRunsService.recordStart({
      workspaceId: null,
      functionId: jobId,
      eventName: jobId,
      eventId: 'evt-real-id',
      lane: 'inngest',
      attempt: 0,
    });

    await invokeOnFailure(fn, {
      event: { id: 'evt-real-id', name: jobId, data: {} },
      runId: 'run-should-not-be-used',
      error: new Error('boom'),
    });

    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.eventId).toBe('evt-real-id');
  });

  it('an EMPTY event id on the event path falls back to the run id rather than becoming a key', async () => {
    // The `||`-not-`??` half, on the arm where a real id is normally present. An
    // empty id must never reach the ledger: every run of the same job would carry
    // it, so it correlates a failure to an arbitrary sibling — or, as happened,
    // to nothing at all.
    const jobId = nextId();
    const fn = defineJob({ id: jobId as never, retryPolicy: 'none' }, () => {
      throw new Error('boom');
    });

    await invokeOnFailure(fn, {
      event: { id: '', name: jobId, data: {} },
      runId: 'run-fallback-1',
      error: new Error('boom'),
    });

    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventId).toBe('run-fallback-1');
    expect(rows[0]!.eventId).not.toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 · THE LANE — recorded, never inferred from the id's shape.
// ─────────────────────────────────────────────────────────────────────────────

describe('every ledger row names the engine that ran it', () => {
  it('records the lane the writer declares, whatever the event id looks like', async () => {
    // The point of the column: an id that matches NEITHER lane pattern (here a
    // plain string) is still attributable, because the writer said so. Under the
    // old cuid-vs-ULID inference this row was counted as neither lane and was
    // invisible to the migration's own read-backs.
    const jobId = nextId();
    await jobRunsService.recordStart({
      workspaceId: null,
      functionId: jobId,
      eventName: jobId,
      eventId: 'not-a-cuid-and-not-a-ulid',
      lane: 'engine',
      attempt: 0,
    });

    const [row] = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(row!.lane).toBe('engine');
  });

  it('carries the lane onto the row a MISSED correlation has to create', async () => {
    // `recordTerminalFailure` still writes a row when it finds no unsettled one
    // (a dead-letter is never dropped). That row is exactly the shape that used
    // to be unattributable, so it is the one that most needs the lane.
    const jobId = nextId();
    const dto = await jobRunsService.recordTerminalFailure({
      functionId: jobId,
      eventId: 'orphan-key',
      lane: 'inngest',
      eventName: jobId,
      workspaceId: null,
      failure: { message: 'nothing to correlate to' },
      eventData: {} as Prisma.InputJsonValue,
      attempts: 1,
    });

    expect(dto!.lane).toBe('inngest');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3 · THE REAP — no row says `running` for ever.
// ─────────────────────────────────────────────────────────────────────────────

describe('the abandoned-run reap', () => {
  const OLD = new Date(Date.now() - JOB_RUN_ABANDON_AFTER_MS - 60_000);

  async function seedRunning(opts: { startedAt: Date; eventId: string }): Promise<string> {
    const jobId = nextId();
    await adminDb.jobRun.create({
      data: {
        workspaceId: null,
        functionId: jobId,
        eventName: `scheduled.${jobId}`,
        eventId: opts.eventId,
        lane: 'inngest',
        attempt: 0,
        status: 'running',
        startedAt: opts.startedAt,
      },
    });
    return jobId;
  }

  it('closes a long-stranded row as `abandoned`, with a code and NO duration', async () => {
    const jobId = await seedRunning({ startedAt: OLD, eventId: 'stranded-1' });

    const outcome = await jobRunsService.reapAbandoned();
    expect(outcome.abandoned).toBe(1);

    const [row] = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(row!.status).toBe('abandoned');
    expect((row!.failure as { code?: string }).code).toBe(JOB_RUN_ABANDONED_CODE);
    expect(row!.finishedAt).not.toBeNull();
    // ⚠️ NULL, deliberately. `finished_at` is when the reap NOTICED, not when the
    // run stopped, so a duration computed from it would be a number nobody
    // measured — which is the genre of thing this whole bug is about.
    expect(row!.durationMs).toBeNull();
  });

  it('leaves a row alone while its queue run is still LIVE, however old it is', async () => {
    // A run sleeping at a `step.sleep` or waiting out a retry backoff is `pending`
    // with a future `run_at`, and its ledger row is legitimately still `running`.
    // Reaping it would close a run that is about to resume.
    const jobId = nextId();
    const queued = await adminDb.jobQueueRun.create({
      data: {
        jobId,
        eventName: `scheduled.${jobId}`,
        runAt: new Date(Date.now() + 3_600_000),
        maxAttempts: 3,
        state: 'pending',
      },
    });
    await adminDb.jobRun.create({
      data: {
        workspaceId: null,
        functionId: jobId,
        eventName: `scheduled.${jobId}`,
        // The engine's `ledgerIdentity` falls back to the QUEUE ROW's id when the
        // run carries no event id — a cron. So the join has to match that column
        // too, not only `event_id`.
        eventId: queued.id,
        lane: 'engine',
        attempt: 0,
        status: 'running',
        startedAt: OLD,
      },
    });

    const outcome = await jobRunsService.reapAbandoned();
    expect(outcome.stillLive).toBe(1);
    expect(outcome.abandoned).toBe(0);

    const [row] = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(row!.status).toBe('running');
  });

  it('leaves a young row alone', async () => {
    const jobId = await seedRunning({ startedAt: new Date(), eventId: 'fresh-1' });

    const outcome = await jobRunsService.reapAbandoned();
    expect(outcome.scanned).toBe(0);

    const [row] = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(row!.status).toBe('running');
  });

  it('never overwrites a row that settled between the read and the write', async () => {
    // The guard on `status = 'running'` in the write. A worker that was merely
    // slow can settle the very run being reaped, and overwriting a real terminal
    // state with `abandoned` would destroy the one record an operator needs.
    const jobId = await seedRunning({ startedAt: OLD, eventId: 'settled-1' });
    await adminDb.jobRun.updateMany({
      where: { functionId: jobId },
      data: { status: 'succeeded', finishedAt: new Date() },
    });

    const outcome = await jobRunsService.reapAbandoned();
    expect(outcome.abandoned).toBe(0);

    const [row] = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(row!.status).toBe('succeeded');
  });

  it('a terminal failure arriving AFTER the reap replaces the guess, it does not add a row', async () => {
    // The reap closes a row nothing appears to be holding. A failure arriving
    // afterwards is the run turning out to have been held after all — and it
    // knows something the reap only guessed: the error. Excluding `abandoned`
    // from the correlation would write a SECOND row, which is the exact defect
    // this bug is about.
    const jobId = await seedRunning({ startedAt: OLD, eventId: 'late-failure-1' });
    await jobRunsService.reapAbandoned();

    await jobRunsService.recordTerminalFailure({
      functionId: jobId,
      eventId: 'late-failure-1',
      lane: 'inngest',
      eventName: `scheduled.${jobId}`,
      workspaceId: null,
      failure: { message: 'it did fail, and here is why' },
      eventData: {} as Prisma.InputJsonValue,
      attempts: 1,
    });

    const rows = await adminDb.jobRun.findMany({ where: { functionId: jobId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect((rows[0]!.failure as { message?: string }).message).toBe('it did fail, and here is why');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4 · THE REAP IS ACTUALLY SCHEDULED.
// ─────────────────────────────────────────────────────────────────────────────

describe('the reap job is registered on both lanes', () => {
  it('is in the ENGINE registry, daily, with the catch-up disposition stated', () => {
    // ⚠️ AN UNREGISTERED CRON FIRES SILENTLY NEVER — no error, no ledger row,
    // nothing. A reaper that never runs is worse than none, because the ledger
    // then LOOKS supervised.
    const registered = engineJob('system.job-run-reap');
    expect(registered).toBeDefined();
    expect(registered!.cron).toBe(JOB_RUN_REAP_CRON);
    // `skip`, not `latest`: the candidate set is defined by elapsed time, so the
    // next fire already sees everything a missed one would have. Re-running the
    // stale tick would do the same work twice.
    expect(registered!.catchUp).toBe('skip');
  });

  it('joins the DAILY band rather than opening a tighter cadence', () => {
    // The clustering constraint (`planTargetLockSweep`'s comment): the longest
    // quiet gap the schedule can ever have is bounded by its TIGHTEST cadence, so
    // a new frequent cron re-prices the always-awake compute for every job. What
    // this recovers has already been wrong for at least six hours and nothing is
    // waiting on it, so daily is right on the merits too.
    const [minute, hour, dom, month, dow] = JOB_RUN_REAP_CRON.split(' ');
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
    expect(Number(hour)).toBeGreaterThanOrEqual(0);
    // Not the top of the hour — a shared minute is a pile-up on one machine.
    expect(minute).not.toBe('0');
  });

  it('its handler calls the sweep and returns what the sweep counted', async () => {
    // Driven through the ENGINE registry's own `handler` — the raw function, which
    // is what the Postgres worker actually invokes. Reaching into the built Inngest
    // object instead would re-enter the whole ledger wrapper and test that, not this.
    const spy = vi
      .spyOn(jobServices.jobRuns, 'reapAbandoned')
      .mockResolvedValue({ scanned: 3, abandoned: 2, stillLive: 1 });
    try {
      const handler = engineJob('system.job-run-reap')!.handler;
      const result = await handler({ step: silentStep } as never, jobServices as never);
      expect(spy).toHaveBeenCalledTimes(1);
      // The counts land on the ledger row's `output`, which is what makes a
      // sweep's result readable on the dashboard rather than only in a log.
      expect(result).toEqual({ scanned: 3, abandoned: 2, stillLive: 1 });
    } finally {
      spy.mockRestore();
    }
  });
});
