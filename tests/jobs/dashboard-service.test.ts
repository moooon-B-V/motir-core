import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { jobsDashboardService } from '@/lib/services/jobsDashboardService';
import { ReplayForbiddenError, DlqEntryNotFoundError } from '@/lib/jobs/errors';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

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
  await db.jobRun.create({
    data: {
      workspaceId: opts.workspaceId,
      functionId: opts.functionId ?? 'email.send',
      eventName: opts.eventName ?? 'email.send',
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
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
  const row = await db.jobRunDlq.create({
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
    sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
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

  it('an owner replays: re-emits the original event payload byte-for-byte and stamps replayedAt', async () => {
    const eventData = {
      to: 'replay@example.com',
      template: 'password-reset',
      data: { recipientName: 'R', resetUrl: 'http://localhost:3000/reset/abc' },
      workspaceId,
      idempotencyKey: 'replay-key-xyz',
    };
    const dlqId = await seedDlq({ workspaceId, eventData });

    const result = await jobsDashboardService.replayDLQ({ dlqId, workspaceId, userId: owner.id });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0]![0] as { name: string; data: unknown };
    expect(sent.name).toBe('email.send');
    // The stored payload is re-emitted unchanged.
    expect(sent.data).toEqual(eventData);

    expect(result.replayedAt).not.toBeNull();
    const reread = await db.jobRunDlq.findUnique({ where: { id: dlqId } });
    expect(reread!.replayedAt).not.toBeNull();
  });
});
