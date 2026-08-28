import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { jobsDashboardService } from '@/lib/services/jobsDashboardService';
import { ReplayForbiddenError, DlqEntryNotFoundError } from '@/lib/jobs/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { randomToken } from '../helpers/random';
import { spyOnJobDispatch } from '../helpers/jobs';

// Operator-dashboard read + replay surface (Story 1.6 · Subtask 1.6.5). Drives
// the service directly against a real Postgres (no mocks except inngest.send,
// which we spy on so a replay's re-emit never leaves the test). Covers the AC's
// four named cases — status filtering, the not-yet-replayed DLQ count, the
// owner-only replay gate, and byte-for-byte event re-emit — plus workspace
// scoping (a workspace only sees its own runs).

let owner: { id: string };
let member: { id: string };
let workspaceId: string;
let otherWorkspaceId: string;

async function seedRun(opts: {
  workspaceId: string | null;
  status: 'running' | 'succeeded' | 'failed';
  functionId?: string;
  eventName?: string;
}): Promise<void> {
  await adminDb.jobRun.create({
    data: {
      workspaceId: opts.workspaceId,
      functionId: opts.functionId ?? 'email.send',
      eventName: opts.eventName ?? 'email.send',
      eventId: `evt-${randomToken()}`,
      lane: 'engine',
      attempt: 0,
      status: opts.status,
    },
  });
}

async function seedDlq(opts: {
  workspaceId: string | null;
  eventData: unknown;
  replayed?: boolean;
}): Promise<string> {
  const row = await adminDb.jobRunDlq.create({
    data: {
      workspaceId: opts.workspaceId,
      functionId: 'email.send',
      eventName: 'email.send',
      eventData: opts.eventData as object,
      failure: { message: 'boom' },
      attempts: 1,
      ...(opts.replayed ? { replayedAt: new Date() } : {}),
    },
  });
  return row.id;
}

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();

  owner = await usersService.createUser({
    email: 'jobs-owner@example.com',
    password: 'hunter2hunter2',
    name: 'Jobs Owner',
  });
  member = await usersService.createUser({
    email: 'jobs-member@example.com',
    password: 'hunter2hunter2',
    name: 'Jobs Member',
  });
  const created = await workspacesService.createWorkspace({
    name: 'Jobs Workspace',
    ownerUserId: owner.id,
  });
  workspaceId = created.workspace.id;
  // A plain member (role: member) — used to assert the non-owner replay gate.
  await workspacesService.addMember({ userId: member.id, workspaceId });

  const other = await workspacesService.createWorkspace({
    name: 'Other Workspace',
    ownerUserId: owner.id,
  });
  otherWorkspaceId = other.workspace.id;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('jobsDashboardService.listJobRuns', () => {
  it('filters by status', async () => {
    await seedRun({ workspaceId, status: 'succeeded' });
    await seedRun({ workspaceId, status: 'failed' });
    await seedRun({ workspaceId, status: 'failed' });
    await seedRun({ workspaceId, status: 'running' });

    const failed = await jobsDashboardService.listJobRuns({
      workspaceId,
      userId: owner.id,
      status: 'failed',
      limit: 50,
      offset: 0,
    });
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.status === 'failed')).toBe(true);

    const all = await jobsDashboardService.listJobRuns({
      workspaceId,
      userId: owner.id,
      limit: 50,
      offset: 0,
    });
    expect(all).toHaveLength(4);
  });

  it('scopes to the active workspace (never another workspace’s runs)', async () => {
    await seedRun({ workspaceId, status: 'succeeded' });
    await seedRun({ workspaceId: otherWorkspaceId, status: 'succeeded' });

    const mine = await jobsDashboardService.listJobRuns({
      workspaceId,
      userId: owner.id,
      limit: 50,
      offset: 0,
    });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.workspaceId).toBe(workspaceId);
  });
});

describe('jobsDashboardService.countDLQ', () => {
  it('excludes already-replayed entries (replayedAt IS NOT NULL)', async () => {
    await seedDlq({ workspaceId, eventData: { a: 1 } });
    await seedDlq({ workspaceId, eventData: { a: 2 } });
    await seedDlq({ workspaceId, eventData: { a: 3 }, replayed: true });

    const count = await jobsDashboardService.countDLQ({ workspaceId, userId: owner.id });
    expect(count).toBe(2);
  });
});

describe('jobsDashboardService.replayDLQ', () => {
  let sendSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    sendSpy = spyOnJobDispatch();
  });
  afterEach(() => {
    sendSpy.mockRestore();
  });

  it('rejects a non-owner caller (and never re-emits)', async () => {
    const dlqId = await seedDlq({ workspaceId, eventData: { to: 'x@example.com' } });

    await expect(
      jobsDashboardService.replayDLQ({ dlqId, workspaceId, userId: member.id }),
    ).rejects.toBeInstanceOf(ReplayForbiddenError);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('rejects a DLQ id from another workspace (anti cross-tenant replay)', async () => {
    const foreignId = await seedDlq({
      workspaceId: otherWorkspaceId,
      eventData: { to: 'y@x.com' },
    });

    await expect(
      jobsDashboardService.replayDLQ({ dlqId: foreignId, workspaceId, userId: owner.id }),
    ).rejects.toBeInstanceOf(DlqEntryNotFoundError);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('an owner replays: re-emits the original event with a re-shaped idempotency key and stamps replayedAt', async () => {
    const eventData = {
      to: 'replay@example.com',
      template: 'password-reset',
      data: { recipientName: 'R', resetUrl: 'http://localhost:3000/reset/abc' },
      workspaceId,
      idempotencyKey: 'replay-key-xyz',
    };
    const dlqId = await seedDlq({ workspaceId, eventData });

    const result = await jobsDashboardService.replayDLQ({ dlqId, workspaceId, userId: owner.id });

    // ⚠️ READ OFF THE ROW, NOT OFF A DISPATCH SPY (MOTIR-3418). A replay used to
    // be a re-send through the transport; it is a `job_event` + `job_queue` pair
    // written straight into the queue now, so the row IS the observation.
    const enqueued = await adminDb.jobEvent.findMany({ where: { name: 'email.send' } });
    expect(enqueued).toHaveLength(1);
    // The payload is re-emitted intact EXCEPT the idempotency key, which is
    // re-shaped to `{original}:replay:{dlqId}` so the `(job_id, idempotency_key)`
    // index does not swallow the replay (PRODECT_FINDINGS #40).
    expect(enqueued[0]!.data).toEqual({
      ...eventData,
      idempotencyKey: `replay-key-xyz:replay:${dlqId}`,
    });

    expect(result.replayedAt).not.toBeNull();
    const reread = await adminDb.jobRunDlq.findUnique({ where: { id: dlqId } });
    expect(reread!.replayedAt).not.toBeNull();
  });
});
