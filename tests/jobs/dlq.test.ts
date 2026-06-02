import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { defineJob } from '@/lib/jobs/defineJob';
import { replayDLQ } from '@/lib/jobs/dlq';
import { withSystemContext } from '@/lib/workspaces/context';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { EmailSendData } from '@/lib/jobs/types';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// Dead-letter queue + replay (Story 1.6 · Subtask 1.6.4). Drives a deliberately
// failing job IN-PROCESS via @inngest/test and asserts the durable contract:
//   1. when a run exhausts its retry budget (here `retryPolicy: 'none'` → the
//      first attempt IS the final one), the wrapper writes BOTH a `failed`
//      job_run row AND a job_run_dlq row, in one transaction;
//   2. the DLQ row carries the original event payload + the serialized failure
//      + the tenancy of the run (real workspace, or null for system/cross-
//      workspace);
//   3. replayDLQ re-emits the ORIGINAL event (same name + data, including the
//      idempotency key — so Inngest's dedup still applies) and stamps
//      replayed_at.
//
// `retryPolicy: 'none'` is what lets the in-process harness reach the DLQ path:
// the test engine runs the handler once (ctx.attempt = 0), and with maxRetries
// = 0 that attempt is final, so the dead-letter branch fires. (For a job with a
// real retry budget, the DLQ write is exercised by the runtime, not the unit
// harness — same boundary as email.send's idempotency dedup, see docs/jobs.md.)

// A throwing job reusing a real event name (no test-only entry in the event
// map). The handler always throws; with `none` it dead-letters on attempt 0.
const failingJob = defineJob({ id: 'email.send', retryPolicy: 'none' }, () => {
  throw new Error('deliberate boom');
});

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

/** Run a job we expect to fail; tolerate the engine surfacing the throw either
 * way (returned `{ error }` or a rejected promise). DB assertions follow. */
async function runFailing(event: EmailSendData): Promise<void> {
  const engine = new InngestTestEngine({
    function: failingJob,
    events: [{ name: 'email.send', data: event }],
  });
  try {
    await engine.execute();
  } catch {
    // swallowed — the failure is the point; we assert on persisted rows.
  }
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('dead-letter on retry-budget exhaustion', () => {
  it('writes BOTH a failed job_run and a job_run_dlq row (untenanted)', async () => {
    await runFailing(emailEvent());

    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
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
    expect(entry.attempts).toBe(1); // none → exactly one attempt
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

    await runFailing(emailEvent({ workspaceId: workspace.id, idempotencyKey: 'dlq-key-2' }));

    const run = (await db.jobRun.findMany())[0]!;
    expect(run.status).toBe('failed');
    expect(run.workspaceId).toBe(workspace.id);

    const entry = (await db.jobRunDlq.findMany())[0]!;
    expect(entry.workspaceId).toBe(workspace.id);
  });

  it('does NOT dead-letter on a non-final attempt (the run stays running)', async () => {
    // A job with a real retry budget: the in-process harness runs attempt 0,
    // which is NOT final (maxRetries = 4 for idempotent), so nothing is written
    // on failure — the row stays `running`, no DLQ row appears.
    const retryingJob = defineJob({ id: 'email.send', retryPolicy: 'idempotent' }, () => {
      throw new Error('still retrying');
    });
    const engine = new InngestTestEngine({
      function: retryingJob,
      events: [{ name: 'email.send', data: emailEvent() }],
    });
    try {
      await engine.execute();
    } catch {
      /* expected */
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

  it('re-emits the original event as-is (same name + data, incl. idempotency key) and stamps replayed_at', async () => {
    await runFailing(emailEvent({ idempotencyKey: 'dlq-key-3' }));
    const entry = (await db.jobRunDlq.findMany())[0]!;

    const result = await withSystemContext((tx) => replayDLQ(entry.id, tx));

    // Re-emitted with the stored event name + the full original payload — so
    // Inngest's same-key dedup still applies (the documented caveat).
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0] as { name: string; data: { idempotencyKey?: string } };
    expect(sent.name).toBe('email.send');
    expect(sent.data.idempotencyKey).toBe('dlq-key-3');

    // The row is stamped (auditable replay).
    expect(result.replayedAt).not.toBeNull();
    const reread = await db.jobRunDlq.findUnique({ where: { id: entry.id } });
    expect(reread!.replayedAt).not.toBeNull();
  });

  it('throws for an unknown DLQ id', async () => {
    await expect(withSystemContext((tx) => replayDLQ('nonexistent-id', tx))).rejects.toThrow(
      /not found/i,
    );
  });
});
