import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { defineJob } from '@/lib/jobs/defineJob';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { dispatchEventToEngine, hasInngestSubscribers } from '@/lib/jobs/engine/dispatcher';
import {
  JOB_ENGINE_JOBS_ENV,
  parseRoutedJobIds,
  routedJobIds,
  routedToEngine,
} from '@/lib/jobs/engine/cutover';
import { engineJobs, engineSubscribers } from '@/lib/jobs/engine/registry';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
// The REAL registry — imported for its side effect, so all 24 definition modules
// are evaluated and `defineJob` has registered every job. The fan-out count below
// is asserted against THIS, not against a fixture, which is the point: adding a
// subscriber to an event cannot silently change the count without a test
// noticing.
import '@/lib/jobs/registry';

// FAN-OUT and the CUTOVER SWITCH (Story MOTIR-3414 · Subtask MOTIR-3423),
// against a real Postgres.

const ORIGINAL_ENV = process.env[JOB_ENGINE_JOBS_ENV];

function routeToEngine(...jobIds: string[]): void {
  process.env[JOB_ENGINE_JOBS_ENV] = jobIds.join(',');
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  delete process.env[JOB_ENGINE_JOBS_ENV];
});

afterEach(async () => {
  await truncateJobRuns();
  if (ORIGINAL_ENV === undefined) delete process.env[JOB_ENGINE_JOBS_ENV];
  else process.env[JOB_ENGINE_JOBS_ENV] = ORIGINAL_ENV;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
async function makeWorkspace(): Promise<string> {
  seq += 1;
  const user = await usersService.createUser({
    email: `dispatch-${seq}@example.com`,
    password: 'hunter2hunter2',
    name: `Dispatch ${seq}`,
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Dispatch WS ${seq}`,
    ownerUserId: user.id,
  });
  return workspace.id;
}

describe('the cutover switch', () => {
  it('DEFAULTS TO INNGEST — a job absent from the configuration is not routed', () => {
    delete process.env[JOB_ENGINE_JOBS_ENV];
    // The safety property the 23 unmoved jobs depend on. The only way onto the
    // new engine is for someone to NAME the job.
    expect(routedToEngine('email.send')).toBe(false);
    expect(routedToEngine('system.attachment-gc')).toBe(false);
    expect(routedJobIds().size).toBe(0);
  });

  it('routes ONLY the named ids, leaving every sibling on Inngest', () => {
    routeToEngine('email.send');
    expect(routedToEngine('email.send')).toBe(true);
    for (const other of engineJobs().filter((d) => d.id !== 'email.send')) {
      expect(routedToEngine(other.id)).toBe(false);
    }
  });

  it('parses a list tolerantly but does not invent members', () => {
    expect(parseRoutedJobIds(undefined)).toEqual(new Set());
    expect(parseRoutedJobIds('')).toEqual(new Set());
    expect(parseRoutedJobIds('  ')).toEqual(new Set());
    expect(parseRoutedJobIds('a, b ,c')).toEqual(new Set(['a', 'b', 'c']));
    // Trailing commas and stray whitespace are an operator typo, not a job named
    // "" — which would match nothing and be invisible.
    expect(parseRoutedJobIds('a,,b,')).toEqual(new Set(['a', 'b']));
  });

  it('is read LIVE, so a change takes effect without a restart', () => {
    delete process.env[JOB_ENGINE_JOBS_ENV];
    expect(routedToEngine('email.send')).toBe(false);
    routeToEngine('email.send');
    expect(routedToEngine('email.send')).toBe(true);
    routeToEngine();
    // Reversible in the same one line — the property the whole migration rests on.
    expect(routedToEngine('email.send')).toBe(false);
  });
});

describe('fan-out — one event, N subscribers', () => {
  it('enqueues exactly ONE run per subscribing job, counted against the REAL registry', async () => {
    const ws = await makeWorkspace();
    // The registry decides the expected count. Asserting a literal 4 here would
    // pass forever after someone added a fifth subscriber.
    const subs = engineSubscribers('work-item/transitioned');
    expect(subs.length).toBeGreaterThan(1); // the event genuinely fans out
    routeToEngine(...subs.map((s) => s.id));

    const result = await dispatchEventToEngine('work-item/transitioned', { workspaceId: ws });

    expect(result.enqueued.sort()).toEqual(subs.map((s) => s.id).sort());
    const runs = await adminDb.jobQueueRun.findMany({ where: { eventId: result.eventId! } });
    expect(runs).toHaveLength(subs.length);
    // One event row, N runs — the reason the log is a table of its own.
    expect(await adminDb.jobEvent.count()).toBe(1);
  });

  it('enqueues ONLY the subscribers that have MOVED — a split set stays split', async () => {
    const ws = await makeWorkspace();
    const subs = engineSubscribers('work-item/transitioned');
    const [moved, ...stayed] = subs;
    expect(stayed.length).toBeGreaterThan(0);
    routeToEngine(moved!.id);

    const result = await dispatchEventToEngine('work-item/transitioned', { workspaceId: ws });

    expect(result.enqueued).toEqual([moved!.id]);
    for (const s of stayed) expect(result.enqueued).not.toContain(s.id);
    // And the event still needs the Inngest transport, for the ones that stayed.
    expect(hasInngestSubscribers('work-item/transitioned')).toBe(true);
  });

  it('writes NOTHING when no subscriber has moved', async () => {
    const ws = await makeWorkspace();
    delete process.env[JOB_ENGINE_JOBS_ENV];

    const result = await dispatchEventToEngine('work-item/transitioned', { workspaceId: ws });

    expect(result).toEqual({
      eventId: null,
      enqueued: [],
      alreadyEnqueued: [],
      coalesced: [],
      failed: [],
    });
    // Not even a `job_event` row: one per emit, for the whole migration, that
    // nothing would ever consume.
    expect(await adminDb.jobEvent.count()).toBe(0);
    expect(await adminDb.jobQueueRun.count()).toBe(0);
  });

  it('stops needing Inngest once EVERY subscriber has moved', async () => {
    const subs = engineSubscribers('work-item/transitioned');
    routeToEngine(...subs.map((s) => s.id));
    expect(hasInngestSubscribers('work-item/transitioned')).toBe(false);
  });

  it('an UNKNOWN event still goes to Inngest — an empty subscriber set is not evidence', () => {
    // The engine registry is complete only for definition modules that have been
    // evaluated. Reading "no subscribers" as "nothing is on Inngest" would drop
    // the event on exactly the request paths that never imported them.
    expect(hasInngestSubscribers('some.event.nothing.registered')).toBe(true);
  });
});

describe('fan-out — idempotency', () => {
  /**
   * Re-enqueue every subscriber for an event that already has runs — what a
   * dispatcher does on restart after dying partway through a fan-out.
   *
   * ⚠️ ONE TRANSACTION PER SUBSCRIBER, exactly as the dispatcher does it. An
   * earlier version of this test batched all of them into a single
   * `withSystemContext`, and the first `P2002` ABORTED that transaction — so
   * every later statement failed with a transaction-aborted error instead of the
   * unique violation, and the test asserted the wrong thing about the right
   * behaviour. The per-subscriber transaction is not a test detail: it is why one
   * duplicate in a real fan-out does not poison the enqueues that follow it.
   */
  async function reEnqueueAll(
    eventId: string,
    workspaceId: string,
    subs: ReadonlyArray<{ id: string; maxAttempts: number }>,
  ): Promise<{ inserted: string[]; rejected: string[] }> {
    const inserted: string[] = [];
    const rejected: string[] = [];
    for (const sub of subs) {
      try {
        await withSystemContext((tx) =>
          jobQueueRepository.create(
            {
              jobId: sub.id,
              eventId,
              eventName: 'work-item/transitioned',
              workspaceId,
              runAt: new Date(),
              maxAttempts: sub.maxAttempts,
            },
            tx,
          ),
        );
        inserted.push(sub.id);
      } catch (err) {
        expect((err as { code?: string }).code).toBe('P2002');
        rejected.push(sub.id);
      }
    }
    return { inserted, rejected };
  }

  it('a dispatcher RETRY does not double-enqueue, driven by actually retrying', async () => {
    const ws = await makeWorkspace();
    const subs = engineSubscribers('work-item/transitioned');
    routeToEngine(...subs.map((s) => s.id));

    const first = await dispatchEventToEngine('work-item/transitioned', { workspaceId: ws });
    expect(first.enqueued).toHaveLength(subs.length);

    const retried = await reEnqueueAll(first.eventId!, ws, subs);

    // EVERY subscriber was rejected by the constraint, and none was inserted.
    expect(retried.inserted).toEqual([]);
    expect(retried.rejected.sort()).toEqual(subs.map((s) => s.id).sort());

    const runs = await adminDb.jobQueueRun.findMany({ where: { eventId: first.eventId! } });
    // Still exactly one run per subscriber. The guarantee is the UNIQUE
    // constraint, not a check-then-insert — which would be a read-derived write
    // with a race in the middle.
    expect(runs).toHaveLength(subs.length);
  });

  it('a PARTIAL fan-out completes on the retry rather than being blocked by it', async () => {
    const ws = await makeWorkspace();
    const subs = engineSubscribers('work-item/transitioned');
    expect(subs.length).toBeGreaterThan(1);
    routeToEngine(...subs.map((s) => s.id));

    // The realistic crash: the dispatcher enqueued the FIRST subscriber and died.
    const event = await adminDb.jobEvent.create({
      data: { name: 'work-item/transitioned', data: { workspaceId: ws }, workspaceId: ws },
    });
    await withSystemContext((tx) =>
      jobQueueRepository.create(
        {
          jobId: subs[0]!.id,
          eventId: event.id,
          eventName: 'work-item/transitioned',
          workspaceId: ws,
          runAt: new Date(),
          maxAttempts: subs[0]!.maxAttempts,
        },
        tx,
      ),
    );

    const retried = await reEnqueueAll(event.id, ws, subs);

    // The one already there is rejected; the rest LAND. Idempotency that also
    // blocked the missing ones would turn a crash mid-fan-out into permanently
    // lost work, which is the failure this shape exists to avoid.
    expect(retried.rejected).toEqual([subs[0]!.id]);
    expect(retried.inserted.sort()).toEqual(
      subs
        .slice(1)
        .map((s) => s.id)
        .sort(),
    );
    const runs = await adminDb.jobQueueRun.findMany({ where: { eventId: event.id } });
    expect(runs).toHaveLength(subs.length);
  });
});

describe('fan-out — a failing subscriber does not take its siblings down', () => {
  it('enqueues every OTHER subscriber when one enqueue throws', async () => {
    const ws = await makeWorkspace();
    const subs = engineSubscribers('work-item/transitioned');
    expect(subs.length).toBeGreaterThan(1);
    routeToEngine(...subs.map((s) => s.id));

    const victim = subs[1]!.id;
    const real = jobQueueRepository.create;
    const spy = vi.spyOn(jobQueueRepository, 'create').mockImplementation(async (data, tx) => {
      if (data.jobId === victim) throw new Error('simulated enqueue failure');
      return real(data, tx);
    });

    const warns: unknown[] = [];
    const result = await dispatchEventToEngine(
      'work-item/transitioned',
      { workspaceId: ws },
      { logger: { warn: (...a: unknown[]) => warns.push(a) } },
    );
    spy.mockRestore();

    // The one that failed is REPORTED, not thrown — fan-out is not a transaction
    // over the consumers, and one unrelated consumer's bad day must not silently
    // drop every notification for the event.
    expect(result.failed).toEqual([{ jobId: victim, error: 'simulated enqueue failure' }]);
    expect(result.enqueued).toEqual(subs.filter((s) => s.id !== victim).map((s) => s.id));
    expect(warns).toHaveLength(1);

    const runs = await adminDb.jobQueueRun.findMany({ where: { eventId: result.eventId! } });
    expect(runs.map((r) => r.jobId).sort()).toEqual(result.enqueued.slice().sort());
  });
});

describe('the enqueued run carries what the worker needs', () => {
  it('copies the tenant, the event name and the job’s own attempt budget', async () => {
    const ws = await makeWorkspace();
    const sub = engineSubscribers('work-item/transitioned')[0]!;
    routeToEngine(sub.id);

    const result = await dispatchEventToEngine('work-item/transitioned', {
      workspaceId: ws,
      workItemId: 'wi_1',
    });
    const run = await adminDb.jobQueueRun.findFirstOrThrow({
      where: { eventId: result.eventId! },
    });

    expect(run.jobId).toBe(sub.id);
    expect(run.eventName).toBe('work-item/transitioned');
    expect(run.workspaceId).toBe(ws);
    // The budget is snapshotted per run, so a later policy change does not
    // retroactively re-budget rows already in flight.
    expect(run.maxAttempts).toBe(sub.maxAttempts);
    expect(run.state).toBe('pending');
    expect(run.attempts).toBe(0);

    const event = await adminDb.jobEvent.findUniqueOrThrow({ where: { id: result.eventId! } });
    expect(event.data).toEqual({ workspaceId: ws, workItemId: 'wi_1' });
    expect(event.workspaceId).toBe(ws);
  });

  it('carries a NULL workspace for a system event rather than refusing it', async () => {
    const sub = engineSubscribers('work-item/transitioned')[0]!;
    routeToEngine(sub.id);
    const result = await dispatchEventToEngine('work-item/transitioned', { workspaceId: null });
    const run = await adminDb.jobQueueRun.findFirstOrThrow({
      where: { eventId: result.eventId! },
    });
    expect(run.workspaceId).toBeNull();
  });
});

describe('the switch prevents a DOUBLE run — both directions', () => {
  // The acceptance criterion in full: "A job routed to the Postgres engine runs
  // there and does NOT also run on Inngest; a job not routed still runs on
  // Inngest. Both directions tested — the second is the one that protects the 23
  // jobs this story does not move."
  //
  // These drive the REAL Inngest execution path (`InngestTestEngine`), because
  // the guard lives inside the function `defineJob` builds and asserting it any
  // other way would assert the guard against itself.

  const HANDLER_RAN = { ran: true } as const;

  function makeProbeJob(id: string, onRun: () => void) {
    // A throwaway job registered under a unique id, so it cannot collide with a
    // real one or leak routing into another test.
    return defineJob({ id: id as never, retryPolicy: 'none' }, () => {
      onRun();
      return HANDLER_RAN;
    });
  }

  it('a job NOT routed still runs on Inngest — the 23 jobs this story does not move', async () => {
    delete process.env[JOB_ENGINE_JOBS_ENV];
    let ran = 0;
    const fn = makeProbeJob('probe.stays-on-inngest', () => {
      ran += 1;
    });

    const { result } = await new InngestTestEngine({ function: fn }).execute();

    // ⚠️ `> 0`, NOT `=== 1`, and the reason is Inngest's own semantics rather
    // than looseness. `defineJob` wraps every handler in `step.run('job-run:start')`
    // and `step.run('job-run:succeeded')`, and the real executor RE-INVOKES the
    // handler body at each step boundary (the memoized steps do not re-execute;
    // the body does). So a handler that ran legitimately is observed twice here.
    // `defineJob`'s own header says so, and it is exactly the property the
    // Postgres shim reproduces. What this test pins is EXECUTED vs DID NOT, which
    // is what the criterion is about.
    expect(ran).toBeGreaterThan(0);
    expect(result).toEqual(HANDLER_RAN);
  });

  it('a job ROUTED to the engine does NOT execute on Inngest', async () => {
    let ran = 0;
    const fn = makeProbeJob('probe.moved-to-postgres', () => {
      ran += 1;
    });
    routeToEngine('probe.moved-to-postgres');

    const { result } = await new InngestTestEngine({ function: fn }).execute();

    // The handler body never ran. Without this guard the migrated job would run
    // on BOTH engines: the Inngest function stays registered on the serve route,
    // and an event with a split subscriber set still reaches Inngest for the sake
    // of the subscribers that have not moved.
    expect(ran).toBe(0);
    // A MARKER rather than a silent undefined, so an operator reading the Inngest
    // dashboard can tell "moved lanes" from "broke".
    expect(result).toEqual({
      skipped: 'routed-to-postgres-engine',
      jobId: 'probe.moved-to-postgres',
    });
  });

  it('and it goes BACK — un-routing the id restores execution on Inngest', async () => {
    let ran = 0;
    const fn = makeProbeJob('probe.round-trip', () => {
      ran += 1;
    });

    routeToEngine('probe.round-trip');
    await new InngestTestEngine({ function: fn }).execute();
    expect(ran).toBe(0);

    // The reversibility the whole migration is built on: one line, no deploy.
    routeToEngine();
    const { result } = await new InngestTestEngine({ function: fn }).execute();
    // `> 0` for the replay reason given above; zero-vs-nonzero is the whole claim.
    expect(ran).toBeGreaterThan(0);
    expect(result).toEqual(HANDLER_RAN);
  });
});
