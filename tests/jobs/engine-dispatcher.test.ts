import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { jobQueueRepository } from '@/lib/repositories/jobQueueRepository';
import { dispatchEventToEngine } from '@/lib/jobs/engine/dispatcher';
import { engineSubscribers } from '@/lib/jobs/engine/registry';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
// The REAL registry — imported for its side effect, so all 24 definition modules
// are evaluated and `defineJob` has registered every job. The fan-out count below
// is asserted against THIS, not against a fixture, which is the point: adding a
// subscriber to an event cannot silently change the count without a test
// noticing.
import '@/lib/jobs/registry';

// FAN-OUT against a real Postgres (Story MOTIR-3414 · Subtask MOTIR-3423).
//
// ⚠️ THIS FILE USED TO TEST A SWITCH AS WELL (MOTIR-3418 removed it). While two
// substrates ran side by side, `MOTIR_POSTGRES_JOB_IDS` decided which
// subscribers of an event the engine enqueued for, and half of this suite drove
// that env var: the default-to-the-old-lane safety property, the split-subscriber
// case, the read-it-live reversibility. There is one lane now, so a dispatch
// enqueues for EVERY subscriber of the event, unconditionally — which is what the
// fan-out assertions below now say without any routing to arrange first.

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

describe('fan-out — one event, N subscribers', () => {
  it('enqueues exactly ONE run per subscribing job, counted against the REAL registry', async () => {
    const ws = await makeWorkspace();
    // The registry decides the expected count. Asserting a literal 4 here would
    // pass forever after someone added a fifth subscriber.
    const subs = engineSubscribers('work-item/transitioned');
    expect(subs.length).toBeGreaterThan(1); // the event genuinely fans out

    const result = await dispatchEventToEngine('work-item/transitioned', { workspaceId: ws });

    expect(result.enqueued.sort()).toEqual(subs.map((s) => s.id).sort());
    const runs = await adminDb.jobQueueRun.findMany({ where: { eventId: result.eventId! } });
    expect(runs).toHaveLength(subs.length);
    // One event row, N runs — the reason the log is a table of its own.
    expect(await adminDb.jobEvent.count()).toBe(1);
  });

  it('an event with NO registered subscriber writes nothing at all', async () => {
    // ⚠️ THREE TESTS STOOD HERE AND THEIR SUBJECT IS GONE (MOTIR-3418). They
    // covered the SPLIT case (enqueue only the subscribers that had moved), the
    // "writes nothing when no subscriber has moved" case, and the transport
    // question `hasInngestSubscribers` answered — does this event still need the
    // old lane at all. With one lane there is no split, no unmoved subscriber and
    // no second transport to ask about.
    //
    // What survives is the one case that was never about the migration: an event
    // nothing subscribes to. It writes NO `job_event` row — one row per emit that
    // nothing would ever consume is the cost this early return exists to avoid.
    await makeWorkspace();

    const result = await dispatchEventToEngine('some.event.nothing.registered', {});

    expect(result).toEqual({
      eventId: null,
      enqueued: [],
      alreadyEnqueued: [],
      coalesced: [],
      failed: [],
    });
    expect(await adminDb.jobEvent.count()).toBe(0);
    expect(await adminDb.jobQueueRun.count()).toBe(0);
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
    const result = await dispatchEventToEngine('work-item/transitioned', { workspaceId: null });
    const run = await adminDb.jobQueueRun.findFirstOrThrow({
      where: { eventId: result.eventId! },
    });
    expect(run.workspaceId).toBeNull();
  });
});

// ⚠️ A WHOLE `describe` STOOD HERE — "the switch prevents a DOUBLE run, both
// directions" (MOTIR-3418 removed it). It drove real probe jobs through the
// vendor's execution path to prove the criterion in full: a job routed to the
// Postgres engine ran there and did NOT also run on the old lane, and a job left
// un-routed still ran on the old one. Both halves named a second engine, and
// there is no longer a second engine for a job to also run on — the property is
// now structural rather than asserted.
