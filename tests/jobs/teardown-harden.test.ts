import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { jobRunsService } from '@/lib/services/jobRunsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { Prisma } from '@prisma/client';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// MOTIR-1545 — a background inngest job can complete (or start, or terminally
// fail) AFTER its tenant workspace — or its own job_run row — has been removed
// out from under it: in production a hard tenant deletion, and in the E2E
// harness a between-test `TRUNCATE ... CASCADE` that a still-in-flight job
// outlives. Recording success/failure/start for such a vanished run is MOOT,
// not an error. If the ledger write throws (the old `recordSuccess` did) or
// trips the workspace FK, the rejection escapes `step.run` as an unhandled
// rejection and degrades the dev WebServer — the intermittent bulk-* E2E shard
// crash this bug tracks. So the job-ledger write path must treat "the run's row
// or its parent workspace is gone" as a benign terminal no-op.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('job-ledger writes are benign no-ops when the run/tenant vanished (MOTIR-1545)', () => {
  it('recordSuccess for a deleted run resolves to null instead of throwing', async () => {
    const started = await jobRunsService.recordStart({
      workspaceId: null,
      functionId: 'email.send',
      eventName: 'email.send',
      eventId: 'evt-vanished-success',
      attempt: 0,
    });

    // Simulate the between-test teardown wiping the ledger while the job is
    // still in flight.
    await truncateJobRuns();

    const result = await jobRunsService.recordSuccess(started!.id, { ok: true });
    expect(result).toBeNull();
    // No row was resurrected.
    expect(await db.jobRun.findMany()).toHaveLength(0);
  });

  it('recordTerminalFailure whose parent workspace was truncated is a benign no-op (no FK throw)', async () => {
    const owner = await usersService.createUser({
      email: 'vanished-owner@example.com',
      password: 'hunter2hunter2',
      name: 'Vanished Owner',
    });
    const created = await workspacesService.createWorkspace({
      name: 'Vanished Workspace',
      ownerUserId: owner.id,
    });
    const workspaceId = created.workspace.id;

    // The stranded onFailure invocation carries the original event, so it goes
    // down recordTerminalFailure's CREATE branch (no `running` row to correlate
    // to) — which would FK-violate against the now-gone workspace.
    await truncateAuthTables(); // wipes the workspace (and cascades its rows)

    const result = await jobRunsService.recordTerminalFailure({
      functionId: 'watcher.notify',
      eventId: 'evt-vanished-failure',
      eventName: 'work-item/comment.created',
      workspaceId,
      failure: { message: 'stranded after teardown' },
      eventData: { workspaceId } as unknown as Prisma.InputJsonValue,
      attempts: 3,
    });
    expect(result).toBeNull();
    // Neither a phantom run nor a DLQ row leaked against the dead tenant.
    expect(await db.jobRun.findMany()).toHaveLength(0);
    expect(await db.jobRunDlq.findMany()).toHaveLength(0);
  });

  it('recordStart against a truncated parent workspace is a benign no-op (no FK throw)', async () => {
    const owner = await usersService.createUser({
      email: 'vanished-start@example.com',
      password: 'hunter2hunter2',
      name: 'Vanished Start',
    });
    const created = await workspacesService.createWorkspace({
      name: 'Vanished Start Workspace',
      ownerUserId: owner.id,
    });
    const workspaceId = created.workspace.id;

    await truncateAuthTables(); // workspace is gone before the job starts

    const result = await jobRunsService.recordStart({
      workspaceId,
      functionId: 'watcher.notify',
      eventName: 'work-item/comment.created',
      eventId: 'evt-vanished-start',
      attempt: 0,
    });
    expect(result).toBeNull();
    expect(await db.jobRun.findMany()).toHaveLength(0);
  });
});
