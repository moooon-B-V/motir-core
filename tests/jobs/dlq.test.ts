import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import { replayDLQ } from '@/lib/jobs/dlq';
import { jobRunsService } from '@/lib/services/jobRunsService';
import { withSystemContext } from '@/lib/workspaces/context';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { EmailSendData } from '@/lib/jobs/types';
import type { Prisma } from '@prisma/client';
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
      attempt: 0,
      idempotencyKey: 'dlq-key-1',
    });

    const dto = await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: 'evt-terminal-1',
      eventName: 'email.send',
      workspaceId: null,
      failure: { message: 'deliberate boom' },
      eventData: emailEvent() as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });
    expect(dto).not.toBeNull();
    expect(dto!.status).toBe('failed');

    // Exactly one run row — the running row was FLIPPED, not duplicated.
    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.id).toBe(started!.id);
    expect(run.status).toBe('failed');
    expect(run.workspaceId).toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect((run.failure as { message?: string } | null)?.message).toBe('deliberate boom');

    const dlq = await db.jobRunDlq.findMany();
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
      attempt: 0,
      idempotencyKey: 'dlq-key-ws',
    });
    await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: 'evt-terminal-ws',
      eventName: 'email.send',
      workspaceId: workspace.id,
      failure: { message: 'tenant boom' },
      eventData: emailEvent({ workspaceId: workspace.id }) as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });

    const run = (await db.jobRun.findMany())[0]!;
    expect(run.status).toBe('failed');
    expect(run.workspaceId).toBe(workspace.id);
    const entry = (await db.jobRunDlq.findMany())[0]!;
    expect(entry.workspaceId).toBe(workspace.id);
  });

  it('writes a fresh failed row + DLQ row when no running row is found (never drops a dead-letter)', async () => {
    // Defensive path: if recordStart was lost or correlation missed, the terminal
    // failure still lands a failed row + DLQ row from the onFailure payload.
    await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: 'orphan-evt',
      eventName: 'email.send',
      workspaceId: null,
      failure: { message: 'orphan boom' },
      eventData: emailEvent({ idempotencyKey: 'orphan-key' }) as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });

    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.eventId).toBe('orphan-evt');
    expect(runs[0]!.attempt).toBe(2); // attempts - 1 (zero-indexed final attempt)
    expect(await db.jobRunDlq.count()).toBe(1);
  });
});

describe('defineJob failure wiring', () => {
  it('registers an onFailure handler (the runtime dead-letter hook)', () => {
    const spy = vi.spyOn(inngest, 'createFunction');
    try {
      defineJob({ id: 'email.send' }, () => undefined);
      const config = spy.mock.calls.at(-1)?.[0] as { onFailure?: unknown } | undefined;
      expect(typeof config?.onFailure).toBe('function');
    } finally {
      spy.mockRestore();
    }
  });

  it('a failing attempt leaves the row running and writes no DLQ (failure bookkeeping is in onFailure)', async () => {
    // The in-process engine runs ONE attempt of the handler; it does not drive
    // onFailure. So a throw leaves the recordStart row `running` and writes no
    // DLQ — exactly the in-flight state the dashboard shows for a retrying run.
    const failingJob = defineJob({ id: 'email.send', retryPolicy: 'none' }, () => {
      throw new Error('still in flight');
    });
    const engine = new InngestTestEngine({
      function: failingJob,
      events: [{ name: 'email.send', data: emailEvent() }],
    });
    try {
      await engine.execute();
    } catch {
      /* the throw is expected; we assert on persisted rows */
    }

    const run = (await db.jobRun.findMany())[0]!;
    expect(run.status).toBe('running');
    expect(run.finishedAt).toBeNull();
    expect(await db.jobRunDlq.findMany()).toHaveLength(0);
  });
});

describe('replayDLQ', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Stop the re-emit from reaching a dev server / cloud; capture the payload.
    sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
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
      attempt: 0,
      idempotencyKey,
    });
    await jobRunsService.recordTerminalFailure({
      functionId: 'email.send',
      eventId: `evt-${idempotencyKey}`,
      eventName: 'email.send',
      workspaceId: null,
      failure: { message: 'boom' },
      eventData: emailEvent({ idempotencyKey }) as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });
    return (await db.jobRunDlq.findFirst())!.id;
  }

  it('re-emits with a RE-SHAPED idempotency key (finding #40) so the replay is not dedup-dropped, and stamps replayed_at', async () => {
    const dlqId = await seedDlqRow('dlq-key-3');

    const result = await withSystemContext((tx) => replayDLQ(dlqId, tx));

    // Re-emitted with the stored event name + payload, but the idempotency key is
    // re-shaped to `{original}:replay:{dlqId}` so Inngest treats it as a new run.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0] as {
      name: string;
      data: { idempotencyKey?: string; to?: string };
    };
    expect(sent.name).toBe('email.send');
    expect(sent.data.idempotencyKey).toBe(`dlq-key-3:replay:${dlqId}`);
    // The rest of the payload is unchanged (same delivery).
    expect(sent.data.to).toBe('dlq@example.com');

    // The row is stamped (auditable replay).
    expect(result.replayedAt).not.toBeNull();
    const reread = await db.jobRunDlq.findUnique({ where: { id: dlqId } });
    expect(reread!.replayedAt).not.toBeNull();
  });

  it('replaying the SAME row twice re-shapes to the SAME key (a double-click dedups, no double-send)', async () => {
    const dlqId = await seedDlqRow('dlq-key-4');

    await withSystemContext((tx) => replayDLQ(dlqId, tx));
    await withSystemContext((tx) => replayDLQ(dlqId, tx));

    const keys = sendSpy.mock.calls.map(
      (c: unknown[]) => (c[0] as { data: { idempotencyKey?: string } }).data.idempotencyKey,
    );
    // Both re-emits carry the SAME dlqId-derived key, so Inngest dedups the
    // second to one delivery.
    expect(keys).toEqual([`dlq-key-4:replay:${dlqId}`, `dlq-key-4:replay:${dlqId}`]);
  });

  it('throws for an unknown DLQ id', async () => {
    await expect(withSystemContext((tx) => replayDLQ('nonexistent-id', tx))).rejects.toThrow(
      /not found/i,
    );
  });
});
