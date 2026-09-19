import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import {
  fakeMonitorProvider,
  fakeMonitorState,
  resetFakeMonitorProvider,
} from '@/lib/monitors/providers/fake';
import { sentryMonitorProvider } from '@/lib/monitors/providers/sentry';
import { registerMonitorProvider } from '@/lib/monitors/registry';
import type { NormalizedMonitorAssignee, NormalizedMonitorIssue } from '@/lib/monitors/types';
import {
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { monitorIssueRepository } from '@/lib/repositories/monitorIssueRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { commentsService } from '@/lib/services/commentsService';
import { monitorConnectionService } from '@/lib/services/monitorConnectionService';
import { monitorIngestionService } from '@/lib/services/monitorIngestionService';
import { monitorSyncService } from '@/lib/services/monitorSyncService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { captureJobEvents } from '../../helpers/jobs';
import { createTestUser, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// The story's VITEST gate (Story MOTIR-4931 · Subtask MOTIR-5708) — § 1, the
// COVERAGE FLOOR over the sync surface. Each block drives one arm the feature
// cards' own suites left dark, through the real services on real Postgres. A
// SPY is used only where the arm is a refusal no fixture can make a real
// service produce on demand (a classifier over three error types, a comment
// write that fails), and each says so.

let capture: ReturnType<typeof captureJobEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  resetFakeMonitorProvider();
  fakeMonitorState().issues = [];
  registerMonitorProvider(fakeMonitorProvider, 'sentry');
  capture = captureJobEvents();
});

afterEach(() => {
  capture.restore();
  registerMonitorProvider(sentryMonitorProvider, 'sentry');
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

interface Seeded {
  fx: WorkItemFixture;
  connectionId: string;
  member: { id: string; email: string };
}

async function seed(): Promise<Seeded> {
  const n = seq++;
  const fx = await makeWorkItemFixture({ name: `Arms ${n}`, identifier: `ARM${n}` });
  await monitorConnectionService.completeGrant(
    {
      provider: 'sentry',
      providerInstallationId: `pi-arms-${n}`,
      code: 'valid-code',
      projectId: fx.projectId,
    },
    fx.ctx,
  );
  const dto = await monitorConnectionService.bindProject(
    fx.projectId,
    { externalProjectId: 'fake-web', externalProjectSlug: 'web' },
    fx.ctx,
  );
  const member = await createTestUser({ email: `arms-${n}@example.com`, name: 'Member' });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return { fx, connectionId: dto.id, member: { id: member.id, email: member.email } };
}

function issue(
  externalId: string,
  assignee: NormalizedMonitorAssignee | null = null,
  minutesAfterNow = 5,
): NormalizedMonitorIssue {
  return {
    externalId,
    title: `Error ${externalId}`,
    culprit: null,
    level: 'error',
    eventCount: 1,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(Date.now() + minutesAfterNow * 60_000),
    permalink: null,
    assignee,
  };
}

const user = (email: string, id = 'u1'): NormalizedMonitorAssignee => ({
  kind: 'user',
  externalId: id,
  email,
  name: 'Someone',
});

const connectionOf = (s: Seeded, boundByUserId: string | null = s.fx.ownerId) => ({
  id: s.connectionId,
  projectId: s.fx.projectId,
  workspaceId: s.fx.workspaceId,
  boundByUserId,
});
const DONE = new Set(['done', 'cancelled']);
const connectionRow = (id: string) =>
  adminDb.monitorConnection.findUniqueOrThrow({ where: { id } });
const bugOf = async (connectionId: string, externalIssueId: string) => {
  const link = await adminDb.monitorIssue.findFirstOrThrow({
    where: { connectionId, externalIssueId },
  });
  return adminDb.workItem.findUniqueOrThrow({ where: { id: link.workItemId! } });
};

async function fileOne(
  s: Seeded,
  externalId: string,
  assignee: NormalizedMonitorAssignee | null = null,
) {
  fakeMonitorState().issues = [...fakeMonitorState().issues, issue(externalId, assignee)];
  await monitorIngestionService.pollConnection(s.connectionId);
  return bugOf(s.connectionId, externalId);
}

describe('the invariant readBug’s null arm rests on', () => {
  it('both listings only ever return links that point at a work item', async () => {
    const s = await seed();
    const kept = await fileOne(s, 'kept');
    const dropped = await fileOne(s, 'dropped', null);
    await adminDb.workItem.updateMany({
      where: { id: { in: [kept.id, dropped.id] } },
      data: { status: 'done' },
    });
    // Deleting a bug nulls its link's pointer (ON DELETE SET NULL) — the one way
    // a link can point at nothing.
    await adminDb.workItem.delete({ where: { id: dropped.id } });

    const byWorkItem = await withSystemContext((tx) =>
      monitorIssueRepository.listByWorkItem(kept.id, tx),
    );
    const resolvable = await withSystemContext(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${s.fx.workspaceId}, true)`;
      return monitorIssueRepository.listResolvableForConnection(
        s.connectionId,
        ['done'],
        new Date(),
        25,
        tx,
      );
    });
    for (const link of [...byWorkItem, ...resolvable]) expect(link.workItemId).not.toBeNull();
    expect(resolvable.map((l) => l.externalIssueId)).toEqual(['kept']);
  });
});

describe('resolve-back arms', () => {
  it('a bug deleted between the link read and the bug read resolves nothing', async () => {
    const s = await seed();
    const bug = await fileOne(s, 'raced');
    vi.spyOn(workItemRepository, 'findById').mockResolvedValueOnce(null);
    const summary = await monitorSyncService.resolveLinkedIssues(bug.id, 'done');
    expect(summary).toEqual({ links: 0, resolved: 0, gone: 0, failed: 0, skipped: 0 });
    expect(fakeMonitorState().resolvedIssues).toEqual([]);
  });

  it('the sweep skips a link whose bug vanished between the listing and the read', async () => {
    const s = await seed();
    const bug = await fileOne(s, 'raced-sweep');
    await adminDb.workItem.update({ where: { id: bug.id }, data: { status: 'done' } });
    vi.spyOn(workItemRepository, 'findById').mockResolvedValueOnce(null);
    const summary = await monitorSyncService.sweepConnection(s.connectionId);
    expect(summary).toMatchObject({ links: 1, skipped: 1, resolved: 0 });
  });

  it('a comment the create path refuses leaves the link gone and names the failure', async () => {
    const s = await seed();
    const bug = await fileOne(s, 'gone-comment');
    await adminDb.workItem.update({ where: { id: bug.id }, data: { status: 'done' } });
    fakeMonitorState().deletedIssues.add('gone-comment');
    // SPY: no fixture makes the binder's own comment fail on demand.
    vi.spyOn(commentsService, 'addComment').mockRejectedValueOnce(new Error('comments are off'));

    await monitorSyncService.resolveLinkedIssues(bug.id, 'done');

    expect(
      (await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'gone-comment' } }))
        .resolveState,
    ).toBe('gone');
    expect((await connectionRow(s.connectionId)).lastSyncError).toContain(
      'saying so on the bug failed: comments are off',
    );
  });

  it('a NON-Error thrown by the comment write is still named', async () => {
    const s = await seed();
    const bug = await fileOne(s, 'gone-string');
    fakeMonitorState().deletedIssues.add('gone-string');
    vi.spyOn(commentsService, 'addComment').mockRejectedValueOnce('a bare string');
    await monitorSyncService.resolveLinkedIssues(bug.id, 'done');
    expect((await connectionRow(s.connectionId)).lastSyncError).toContain('a bare string');
  });

  it('a poll with resolveOnDone OFF runs no sweep at all', async () => {
    const s = await seed();
    await monitorConnectionService.setSyncDirections(
      s.fx.projectId,
      s.connectionId,
      { resolveOnDone: false },
      s.fx.ctx,
    );
    const sweep = vi.spyOn(monitorSyncService, 'sweepConnection');
    await monitorIngestionService.pollConnection(s.connectionId);
    expect(sweep).not.toHaveBeenCalled();
  });

  it('a sweep throwing a NON-Error is recorded, not thrown', async () => {
    const s = await seed();
    vi.spyOn(monitorSyncService, 'sweepConnection').mockRejectedValueOnce('sweep string');
    const summary = await monitorIngestionService.pollConnection(s.connectionId);
    expect(summary.status).toBe('ok');
    expect((await connectionRow(s.connectionId)).lastSyncError).toContain('sweep string');
  });
});

describe('assignee arms', () => {
  it('a link the lock cannot find is unchanged', async () => {
    const s = await seed();
    expect(
      await monitorSyncService.applyAssignee(
        connectionOf(s),
        'no-such-issue',
        user(s.member.email),
        DONE,
      ),
    ).toBe('unchanged');
  });

  it('a bug ALREADY assigned to the matched member records the key and writes nothing', async () => {
    const s = await seed();
    const bug = await fileOne(s, 'already');
    await workItemsService.updateWorkItem(bug.id, { assigneeId: s.member.id }, s.fx.ctx);
    const update = vi.spyOn(workItemsService, 'updateWorkItem');

    const outcome = await monitorSyncService.applyAssignee(
      connectionOf(s),
      'already',
      user(s.member.email),
      DONE,
    );

    expect(outcome).toBe('unchanged');
    expect(update).not.toHaveBeenCalled();
    expect(
      (await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'already' } }))
        .syncedAssigneeExternalId,
    ).toBe('user:u1');
  });

  it.each([
    ['PermissionDeniedError', () => new PermissionDeniedError('p', 'work_item:edit')],
    ['ProjectAccessDeniedError', () => new ProjectAccessDeniedError('p', 'edit')],
    ['ProjectNotFoundError', () => new ProjectNotFoundError('p')],
  ])('a binder refused with %s records a NAMED failure and assigns nothing', async (_, make) => {
    const s = await seed();
    await fileOne(s, 'refused');
    // SPY: the three refusals the classifier knows, one each.
    vi.spyOn(workItemsService, 'updateWorkItem').mockRejectedValueOnce(make());

    const outcome = await monitorSyncService.applyAssignee(
      connectionOf(s),
      'refused',
      user(s.member.email),
      DONE,
    );

    expect(outcome).toBe('binder_unavailable');
    expect((await connectionRow(s.connectionId)).lastSyncError).toContain(
      'The person who bound this connection could not assign',
    );
  });

  it('an error the classifier does not know is thrown — and the poll records it, never fails', async () => {
    const s = await seed();
    await fileOne(s, 'boom');
    vi.spyOn(workItemsService, 'updateWorkItem').mockRejectedValueOnce(new Error('db down'));
    await expect(
      monitorSyncService.applyAssignee(connectionOf(s), 'boom', user(s.member.email), DONE),
    ).rejects.toThrow('db down');

    // Through the poll's reconcile-visit hook: recorded on SYNC, the poll stands.
    fakeMonitorState().issues = [issue('boom-2', user(s.member.email, 'u5'))];
    vi.spyOn(monitorSyncService, 'applyAssignee').mockRejectedValueOnce(new Error('hook broke'));
    const summary = await monitorIngestionService.pollConnection(s.connectionId);
    expect(summary).toMatchObject({ status: 'ok', filed: 1 });
    expect((await connectionRow(s.connectionId)).lastSyncError).toContain(
      'Taking assignees from the monitor stopped: hook broke',
    );
  });

  it('the refresh stamps a GONE issue and applies nothing to it', async () => {
    const s = await seed();
    await fileOne(s, 'vanished');
    fakeMonitorState().deletedIssues.add('vanished');
    const apply = vi.spyOn(monitorSyncService, 'applyAssignee');

    await monitorSyncService.refreshAssignees(
      { ...connectionOf(s), installationId: (await connectionRow(s.connectionId)).installationId },
      DONE,
    );

    expect(apply).not.toHaveBeenCalled();
    expect(
      (await adminDb.monitorIssue.findFirstOrThrow({ where: { externalIssueId: 'vanished' } }))
        .assigneeCheckedAt,
    ).not.toBeNull();
  });

  it('an UNEXPECTED refresh error propagates, and the poll records a non-Error one on SYNC', async () => {
    const s = await seed();
    await fileOne(s, 'refresh-boom');
    const installationId = (await connectionRow(s.connectionId)).installationId;
    vi.spyOn(fakeMonitorProvider, 'getIssue').mockRejectedValueOnce(new Error('not a refusal'));
    await expect(
      monitorSyncService.refreshAssignees({ ...connectionOf(s), installationId }, DONE),
    ).rejects.toThrow('not a refusal');

    vi.spyOn(monitorSyncService, 'refreshAssignees').mockRejectedValueOnce('refresh string');
    const summary = await monitorIngestionService.pollConnection(s.connectionId);
    expect(summary.status).toBe('ok');
    expect((await connectionRow(s.connectionId)).lastSyncError).toContain('refresh string');
  });
});
