import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService, MAX_BULK_BATCH_SIZE } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  BulkBatchTooLargeError,
  CrossProjectSprintAssignmentError,
  SprintNotFoundError,
} from '@/lib/sprints/errors';
import { makeWorkItemFixture, createTestProject } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItemDto } from '@/lib/dto/workItems';

type Two = [WorkItemDto, WorkItemDto];
type Three = [WorkItemDto, WorkItemDto, WorkItemDto];

// Integration tests for the Story-4.2 backend composition (Subtask 4.2.2): the
// ATOMIC bulk sprint-assign / move-to-backlog + create-into-sprint that compose
// Story 4.1.4's single-issue primitives. Real Postgres (no mocks), per CLAUDE.md.
// Story 4.1.5 already proves the single-issue association/rank + bounded reads;
// here we prove the BULK composition + the create-into-sprint path + the
// empty-input / batch-bound / cross-project guards + the 1.4.6 revisions.

/** Create `titles.length` backlog issues via the real create path (each gets a
 *  create-time backlogRank appended), in creation = ascending-rank order. */
async function createBacklog(fx: WorkItemFixture, titles: string[]): Promise<WorkItemDto[]> {
  const items: WorkItemDto[] = [];
  for (const title of titles) {
    items.push(
      await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title },
        fx.ctx,
      ),
    );
  }
  return items;
}

async function backlogIds(fx: WorkItemFixture): Promise<string[]> {
  const page = await backlogService.getBacklog(fx.projectId, { limit: 100 }, fx.ctx);
  return page.items.map((i) => i.id);
}

async function sprintIds(fx: WorkItemFixture, sprintId: string): Promise<string[]> {
  const page = await backlogService.getSprintIssues(sprintId, { limit: 100 }, fx.ctx);
  return page.items.map((i) => i.id);
}

async function revisionCount(workItemId: string): Promise<number> {
  return db.workItemRevision.count({ where: { workItemId } });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('backlogService.bulkAssignToSprint', () => {
  it('moves the whole selection into the sprint in one action, appended in selection order, with revisions', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkAssign' });
    const [a, b, c] = (await createBacklog(fx, ['A', 'B', 'C'])) as Three;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const revA = await revisionCount(a.id);

    // Select c then a (out of backlog order) — they should land in the sprint in
    // SELECTION order (c above a), and only b remains in the backlog.
    const moved = await backlogService.bulkAssignToSprint([c.id, a.id], sprint.id, fx.ctx);

    expect(moved.map((m) => m.id)).toEqual([c.id, a.id]);
    expect(moved.every((m) => m.sprintId === sprint.id)).toBe(true);
    expect(await backlogIds(fx)).toEqual([b.id]);
    expect(await sprintIds(fx, sprint.id)).toEqual([c.id, a.id]); // appended in selection order
    expect(await revisionCount(a.id)).toBe(revA + 1); // one revision per moved item
  });

  it('appends a bulk batch AFTER issues already in the sprint', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkAppend' });
    const [a, b, c] = (await createBacklog(fx, ['A', 'B', 'C'])) as Three;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx); // a is first

    await backlogService.bulkAssignToSprint([b.id, c.id], sprint.id, fx.ctx);

    expect(await sprintIds(fx, sprint.id)).toEqual([a.id, b.id, c.id]); // a, then the batch
  });

  it('collapses duplicate ids — the same issue is moved/ranked once', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkDup' });
    const [a] = (await createBacklog(fx, ['A'])) as [WorkItemDto];
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);

    const moved = await backlogService.bulkAssignToSprint([a.id, a.id, a.id], sprint.id, fx.ctx);

    expect(moved.map((m) => m.id)).toEqual([a.id]);
    expect(await sprintIds(fx, sprint.id)).toEqual([a.id]);
  });

  it('empty itemIds is a guarded no-op (returns [], not an error)', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkEmpty' });
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await expect(backlogService.bulkAssignToSprint([], sprint.id, fx.ctx)).resolves.toEqual([]);
  });

  it('rejects an oversize batch with BulkBatchTooLargeError before any write', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkBig' });
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const ids = Array.from({ length: MAX_BULK_BATCH_SIZE + 1 }, (_, i) => `id-${i}`);
    await expect(backlogService.bulkAssignToSprint(ids, sprint.id, fx.ctx)).rejects.toBeInstanceOf(
      BulkBatchTooLargeError,
    );
  });

  it('throws SprintNotFoundError for an unknown sprint', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkNoSprint' });
    const [a] = (await createBacklog(fx, ['A'])) as [WorkItemDto];
    await expect(
      backlogService.bulkAssignToSprint([a.id], 'missing-sprint', fx.ctx),
    ).rejects.toBeInstanceOf(SprintNotFoundError);
  });

  it('rejects the WHOLE batch atomically if any member is cross-project (none moved)', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkCross' });
    const [a, b] = (await createBacklog(fx, ['A', 'B'])) as Two;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    // A second project in the SAME workspace with its own issue.
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTH',
    });
    const foreign = await workItemsService.createWorkItem(
      { projectId: otherProject.id, kind: 'task', title: 'Foreign' },
      fx.ctx,
    );

    await expect(
      backlogService.bulkAssignToSprint([a.id, foreign.id, b.id], sprint.id, fx.ctx),
    ).rejects.toBeInstanceOf(CrossProjectSprintAssignmentError);

    // Atomic: the valid siblings were NOT moved.
    expect(await sprintIds(fx, sprint.id)).toEqual([]);
    expect(await backlogIds(fx)).toEqual([a.id, b.id]);
  });

  it('throws WorkItemNotFoundError for a foreign-workspace member (none moved)', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkTenant' });
    const [a] = (await createBacklog(fx, ['A'])) as [WorkItemDto];
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const otherItem = (await createBacklog(other, ['X']))[0]!;

    await expect(
      backlogService.bulkAssignToSprint([a.id, otherItem.id], sprint.id, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(await sprintIds(fx, sprint.id)).toEqual([]); // none moved
  });
});

describe('backlogService.bulkMoveToBacklog', () => {
  it('moves the whole selection back to the backlog (rank preserved) with revisions', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkBack' });
    const [a, b, c] = (await createBacklog(fx, ['A', 'B', 'C'])) as Three;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await backlogService.bulkAssignToSprint([a.id, b.id, c.id], sprint.id, fx.ctx);
    const revA = await revisionCount(a.id);

    const moved = await backlogService.bulkMoveToBacklog([a.id, c.id], fx.ctx);

    expect(moved.every((m) => m.sprintId === null)).toBe(true);
    expect(await sprintIds(fx, sprint.id)).toEqual([b.id]); // only b stays
    // a + c reappear in the backlog in their original rank order (A before C).
    expect(await backlogIds(fx)).toEqual([a.id, c.id]);
    expect(await revisionCount(a.id)).toBe(revA + 1);
  });

  it('is a per-item no-op for an issue already in the backlog (no revision, still returned)', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkBackNoop' });
    const [a] = (await createBacklog(fx, ['A'])) as [WorkItemDto];
    const revA = await revisionCount(a.id);

    const moved = await backlogService.bulkMoveToBacklog([a.id], fx.ctx);

    expect(moved.map((m) => m.id)).toEqual([a.id]);
    expect(await revisionCount(a.id)).toBe(revA); // no write, no revision
  });

  it('empty itemIds is a guarded no-op (returns [])', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkBackEmpty' });
    await expect(backlogService.bulkMoveToBacklog([], fx.ctx)).resolves.toEqual([]);
  });

  it('rejects an oversize batch with BulkBatchTooLargeError', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkBackBig' });
    const ids = Array.from({ length: MAX_BULK_BATCH_SIZE + 1 }, (_, i) => `id-${i}`);
    await expect(backlogService.bulkMoveToBacklog(ids, fx.ctx)).rejects.toBeInstanceOf(
      BulkBatchTooLargeError,
    );
  });

  it('throws WorkItemNotFoundError for a foreign-workspace member (none moved)', async () => {
    const fx = await makeWorkItemFixture({ name: 'BulkBackTenant' });
    const [a, b] = (await createBacklog(fx, ['A', 'B'])) as Two;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await backlogService.bulkAssignToSprint([a.id, b.id], sprint.id, fx.ctx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const otherItem = (await createBacklog(other, ['X']))[0]!;

    await expect(
      backlogService.bulkMoveToBacklog([a.id, otherItem.id], fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    // Atomic: a was NOT moved out of the sprint.
    expect(await sprintIds(fx, sprint.id)).toEqual([a.id, b.id]);
  });
});

describe('backlogService.createBacklogIssue', () => {
  it('creates an issue into the backlog (rank-appended) when no sprint is given', async () => {
    const fx = await makeWorkItemFixture({ name: 'CreateBacklog' });
    const [a] = (await createBacklog(fx, ['A'])) as [WorkItemDto];

    const created = await backlogService.createBacklogIssue(
      fx.projectId,
      { kind: 'task', title: 'New' },
      fx.ctx,
    );

    expect(created.sprintId).toBeNull();
    expect(await backlogIds(fx)).toEqual([a.id, created.id]); // appended after A
    expect(await revisionCount(created.id)).toBe(1); // the create revision
  });

  it('creates an issue directly INTO a sprint (assigned + appended) in one action', async () => {
    const fx = await makeWorkItemFixture({ name: 'CreateInSprint' });
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);

    const created = await backlogService.createBacklogIssue(
      fx.projectId,
      { kind: 'task', title: 'Sprinted', sprintId: sprint.id },
      fx.ctx,
    );

    expect(created.sprintId).toBe(sprint.id);
    expect(await backlogIds(fx)).toEqual([]); // not in the backlog
    expect(await sprintIds(fx, sprint.id)).toEqual([created.id]);
    // The created revision captures the born-in-sprint assignment.
    const revision = await db.workItemRevision.findFirst({ where: { workItemId: created.id } });
    expect((revision?.diff as Record<string, unknown>)?.sprintId).toEqual({
      from: null,
      to: sprint.id,
    });
  });

  it('rejects create-into-sprint for a cross-project sprint (issue NOT created)', async () => {
    const fx = await makeWorkItemFixture({ name: 'CreateCross' });
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTH',
    });
    const otherSprint = await sprintsService.createSprint(otherProject.id, {}, fx.ctx);

    await expect(
      backlogService.createBacklogIssue(
        fx.projectId,
        { kind: 'task', title: 'Bad', sprintId: otherSprint.id },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossProjectSprintAssignmentError);
    expect(await backlogIds(fx)).toEqual([]); // nothing created
  });

  it('throws SprintNotFoundError for an unknown sprint (issue NOT created)', async () => {
    const fx = await makeWorkItemFixture({ name: 'CreateNoSprint' });
    await expect(
      backlogService.createBacklogIssue(
        fx.projectId,
        { kind: 'task', title: 'Bad', sprintId: 'missing' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(SprintNotFoundError);
    expect(await backlogIds(fx)).toEqual([]);
  });
});
