import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobTestEngine, spyOnJobDispatch } from '../helpers/jobs';
import { db } from '@/lib/db';
import { defineJob } from '@/lib/jobs/defineJob';
import { replayDLQ } from '@/lib/jobs/dlq';
import { jobRunsService } from '@/lib/services/jobRunsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { EmailSendData } from '@/lib/jobs/types';
import type { Prisma } from '@/generated/prisma/client';
import { adminDb } from '../helpers/adminDb';
// Side-effect import: evaluates `email.send`'s definition module so the engine
// registry knows the job. The replay reads its `idempotency` template from there
// — without it `resolveIdempotencyKey` gets `undefined`, falls back to a null
// key, and the dedup this file asserts cannot engage at all.
import '@/lib/jobs/definitions/emailSend';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Dead-letter queue + replay (Story 1.6 · Subtask 1.6.4, REWORKED in 1.6.6).
//
// 1.6.4 wrote the dead-letter from a try/catch in the job handler and unit-
// tested it by running that handler in-process. PRODECT_FINDINGS #39 found that
// path never executes on the REAL Inngest runtime (a step scheduled after the
// terminally-failed step is dropped), so the dead-letter is now written by
// Inngest's `onFailure` handler instead — and `onFailure` is a separate runtime
// invocation the in-process harness does not drive. So the honest unit surface
// here is:
//   1. the `recordTerminalFailure` SERVICE method (the actual dead-letter logic,
//      correlating back to the `running` row by eventId), tested directly;
//   2. `defineJob` WIRING an onFailure handler into the Inngest config;
//   3. a failing attempt leaving the row `running` (no premature failure);
//   4. `replayDLQ` re-emitting with a RE-SHAPED idempotency key (finding #40) so
//      the replay isn't dedup-dropped, and stamping replayed_at.
// The full failure → DLQ → replay path on the real runtime is covered E2E in
// tests/e2e/jobs-flow.spec.ts (the only place the real executor runs).

function emailEvent(overrides: Partial<EmailSendData> = {}): EmailSendData {
  return {
    workspaceId: null,
    idempotencyKey: 'dlq-key-1',
    to: 'dlq@example.com',
    template: 'password-reset',
    data: { recipientName: 'DLQ User', resetUrl: 'http://localhost:3000/reset/x' },
    ...overrides,
  } as EmailSendData;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('recordTerminalFailure — correlates to the running row', () => {
  it('flips the existing running row to failed AND writes a DLQ row (untenanted)', async () => {
    // The shape onFailure produces: a `running` row already exists (recordStart),
    // and the terminal-failure write correlates to it by (functionId, eventId).
    const started = await jobRunsService.recordStart({
      workspaceId: null,
      functionId: 'email.send',
      eventName: 'email.send',
      eventId: 'evt-terminal-1',
      lane: 'engine',
      attempt: 0,
      idempotencyKey: 'dlq-key-1',
    });

    const dto = await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: 'evt-terminal-1',
      lane: 'engine',
      eventName: 'email.send',
      workspaceId: null,
      failure: { message: 'deliberate boom' },
      eventData: emailEvent() as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });
    expect(dto).not.toBeNull();
    expect(dto!.status).toBe('failed');

    // Exactly one run row — the running row was FLIPPED, not duplicated.
    const runs = await adminDb.jobRun.findMany();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.id).toBe(started!.id);
    expect(run.status).toBe('failed');
    expect(run.workspaceId).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect((run.failure as { message?: string } | null)?.message).toBe('deliberate boom');

    const dlq = await adminDb.jobRunDlq.findMany();
    expect(dlq).toHaveLength(1);
    const entry = dlq[0]!;
    expect(entry.functionId).toBe('email.send');
    expect(entry.eventName).toBe('email.send');
    expect(entry.workspaceId).toBeNull();
    expect(entry.attempts).toBe(3);
    expect(entry.replayedAt).toBeNull();
    expect((entry.failure as { message?: string }).message).toBe('deliberate boom');
    // The full original payload is persisted for replay.
    expect((entry.eventData as { idempotencyKey?: string }).idempotencyKey).toBe('dlq-key-1');
    expect((entry.eventData as { to?: string }).to).toBe('dlq@example.com');
    // firstFailedAt brackets the run start; lastFailedAt is the exhaustion time.
    expect(entry.firstFailedAt.getTime()).toBeLessThanOrEqual(entry.lastFailedAt.getTime());
  });

  it('inherits the run tenancy: a workspace-scoped failure dead-letters under that workspace', async () => {
    const owner = await usersService.createUser({
      email: 'dlq-owner@example.com',
      password: 'hunter2hunter2',
      name: 'DLQ Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'DLQ Workspace',
      ownerUserId: owner.id,
    });

    await jobRunsService.recordStart({
      workspaceId: workspace.id,
      functionId: 'email.send',
      eventName: 'email.send',
      eventId: 'evt-terminal-ws',
      lane: 'engine',
      attempt: 0,
      idempotencyKey: 'dlq-key-ws',
    });
    await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: 'evt-terminal-ws',
      lane: 'engine',
      eventName: 'email.send',
      workspaceId: workspace.id,
      failure: { message: 'tenant boom' },
      eventData: emailEvent({ workspaceId: workspace.id }) as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });

    const run = (await adminDb.jobRun.findMany())[0]!;
    expect(run.status).toBe('failed');
    expect(run.workspaceId).toBe(workspace.id);
    const entry = (await adminDb.jobRunDlq.findMany())[0]!;
    expect(entry.workspaceId).toBe(workspace.id);
  });

  it('writes a fresh failed row + DLQ row when no running row is found (never drops a dead-letter)', async () => {
    // Defensive path: if recordStart was lost or correlation missed, the terminal
    // failure still lands a failed row + DLQ row from the onFailure payload.
    await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: 'orphan-evt',
      lane: 'engine',
      eventName: 'email.send',
      workspaceId: null,
      failure: { message: 'orphan boom' },
      eventData: emailEvent({ idempotencyKey: 'orphan-key' }) as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });

    const runs = await adminDb.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.eventId).toBe('orphan-evt');
    expect(runs[0]!.attempt).toBe(2); // attempts - 1 (zero-indexed final attempt)
    const jobRunDlqCount = await adminDb.jobRunDlq.count();
    expect(jobRunDlqCount).toBe(1);
  });
});

describe('the terminal-failure wiring', () => {
  it('a definition carries the retry budget the dead-letter hook settles against', () => {
    // ⚠️ THIS USED TO ASSERT AN `onFailure` KEY ON THE VENDOR CONFIG (MOTIR-3418).
    // `defineJob` built one, and it was that hook — a SEPARATE invocation the
    // executor made after a run exhausted its budget — that wrote the `failed` +
    // dead-letter rows. The engine has no per-job hook: the worker settles a run
    // whose `attempts` have reached `maxAttempts` and calls
    // `recordEngineTerminalFailure` (`lib/jobs/engine/ledger.ts`) once, in one
    // place, for every job. So what a DEFINITION owes is the budget that decides
    // when that happens, and that is what is asserted here; the write itself is
    // asserted where it now lives, in `tests/jobs/engine-ledger.test.ts`.
    //
    // ⚠️ A THROWAWAY ID, NOT `email.send`. `registerEngineJob` overwrites by id,
    // so re-declaring a REAL job here replaces the shipped registration for the
    // rest of the file — and the replay tests below read `email.send`'s
    // `idempotency` template out of that registry. Declaring it without one
    // silently disabled the dedup those tests assert, and they failed two files
    // later with a row count.
    const def = defineJob({ id: 'test.dlq-budget' as never }, () => undefined);
    expect(def.maxAttempts).toBe(3);
  });

  it('a failing attempt leaves the row running and writes no DLQ (failure bookkeeping is in onFailure)', async () => {
    // The in-process engine runs ONE attempt of the handler; it does not drive
    // onFailure. So a throw leaves the recordStart row `running` and writes no
    // DLQ — exactly the in-flight state the dashboard shows for a retrying run.
    // A throwaway id for the reason the test above gives: re-declaring
    // `email.send` here would overwrite the shipped registration this file's
    // replay tests read from.
    const failingJob = defineJob({ id: 'test.dlq-failing' as never, retryPolicy: 'none' }, () => {
      throw new Error('still in flight');
    });
    const engine = new JobTestEngine({
      function: failingJob,
      events: [{ name: 'test.dlq-failing', data: emailEvent() }],
    });
    try {
      await engine.execute();
    } catch {
      /* the throw is expected; we assert on persisted rows */
    }

    const run = (await adminDb.jobRun.findMany())[0]!;
    expect(run.status).toBe('running');
    expect(run.finishedAt).toBeNull();
    const jobRunDlqRows = await adminDb.jobRunDlq.findMany();
    expect(jobRunDlqRows).toHaveLength(0);
  });
});

describe('replayDLQ', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Stop the re-emit from reaching a dev server / cloud; capture the payload.
    sendSpy = spyOnJobDispatch();
  });
  afterEach(() => {
    sendSpy.mockRestore();
  });

  async function seedDlqRow(idempotencyKey: string): Promise<string> {
    await jobRunsService.recordStart({
      workspaceId: null,
      functionId: 'email.send',
      eventName: 'email.send',
      eventId: `evt-${idempotencyKey}`,
      lane: 'engine',
      attempt: 0,
      idempotencyKey,
    });
    await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: `evt-${idempotencyKey}`,
      lane: 'engine',
      eventName: 'email.send',
      workspaceId: null,
      failure: { message: 'boom' },
      eventData: emailEvent({ idempotencyKey }) as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });
    return (await adminDb.jobRunDlq.findFirst())!.id;
  }

  it('re-emits with a RE-SHAPED idempotency key (finding #40) so the replay is not dedup-dropped, and stamps replayed_at', async () => {
    const dlqId = await seedDlqRow('dlq-key-3');

    const result = await withSystemContext((tx) => replayDLQ(dlqId, tx));
    expect(result.outcome).toBe('replayed');

    // ⚠️ READ OFF THE ROWS, NOT OFF A SPY (MOTIR-3418). A replay used to be a
    // re-SEND through the transport, so a spy on it was the observation. It is a
    // fresh `job_event` + `job_queue` pair written straight into the queue now,
    // which is a strictly better observation: it is also what the dedup index is
    // enforced against.
    const enqueued = await adminDb.jobEvent.findMany({
      where: { name: 'email.send' },
      orderBy: { receivedAt: 'desc' },
    });
    expect(enqueued).toHaveLength(1);
    const sent = enqueued[0]!.data as { idempotencyKey?: string; to?: string };
    // The key is re-shaped to `{original}:replay:{dlqId}` so the partial UNIQUE
    // on `(job_id, idempotency_key)` does not swallow it.
    expect(sent.idempotencyKey).toBe(`dlq-key-3:replay:${dlqId}`);
    // The rest of the payload is unchanged (same delivery).
    expect(sent.to).toBe('dlq@example.com');

    // The row is stamped (auditable replay).
    expect(result.entry.replayedAt).not.toBeNull();
    const reread = await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } });
    expect(reread!.replayedAt).not.toBeNull();
  });

  it('replaying the SAME row twice REPORTS the second as already-replayed — it does not throw', async () => {
    const dlqId = await seedDlqRow('dlq-key-4');

    const first = await withSystemContext((tx) => replayDLQ(dlqId, tx));
    expect(first.outcome).toBe('replayed');
    const firstStamp = first.entry.replayedAt;

    // ⚠️ THE DEDUP IS THE MECHANISM AND IT IS UNCHANGED (MOTIR-3730). The replay
    // key is derived from the DLQ row id, so a second click derives the SAME key
    // and the `(job_id, idempotency_key)` partial unique refuses the insert —
    // exactly as designed, so a double-click cannot double-deliver. What changed
    // is what the caller is TOLD: the violation is absorbed at the INSERT and
    // reported, instead of surfacing as a raw `P2002` out of the dashboard's
    // Server Action.
    const second = await withSystemContext((tx) => replayDLQ(dlqId, tx));
    expect(second.outcome).toBe('already-replayed');

    // ONE queued run, carrying the re-shaped key — nothing new was enqueued.
    const queued = await adminDb.jobQueueRun.findMany({ where: { jobId: 'email.send' } });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.idempotencyKey).toBe(`dlq-key-4:replay:${dlqId}`);

    // AND no orphan event: the second attempt writes its `job_event` before it
    // can know the run is a duplicate (the run carries the FK), so the no-op arm
    // removes it. One replay, one event.
    const events = await adminDb.jobEvent.findMany({ where: { name: 'email.send' } });
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(queued[0]!.eventId);

    // The stamp still records the replay that actually enqueued — a no-op must
    // not tell an operator their second click did something.
    const reread = await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } });
    expect(reread!.replayedAt?.toISOString()).toBe(firstStamp);
    expect(second.entry.replayedAt).toBe(firstStamp);
  });

  it("leaves the CALLER's transaction usable — the no-op arm never aborts it", async () => {
    const dlqId = await seedDlqRow('dlq-key-5');
    await withSystemContext((tx) => replayDLQ(dlqId, tx));

    // ⚠️ THIS IS THE REGRESSION GUARD, and it is why the fix could not be a
    // `try/catch` on `P2002` (MOTIR-3730). A raised unique violation aborts the
    // whole enclosing Postgres transaction — every later statement answers
    // `25P02 current transaction is aborted`, and the COMMIT then rolls back and
    // reports success. `replayDLQ` runs inside the transaction the dashboard
    // service opens and goes on using, so the caller has to be able to keep
    // working after an already-replayed answer.
    const outcome = await withSystemContext(async (tx) => {
      const result = await replayDLQ(dlqId, tx);
      // A statement AFTER the duplicate, on the SAME transaction.
      const stillUsable = await tx.jobRunDlq.count();
      return { result, stillUsable };
    });
    expect(outcome.result.outcome).toBe('already-replayed');
    expect(outcome.stillUsable).toBe(1);
  });
});
