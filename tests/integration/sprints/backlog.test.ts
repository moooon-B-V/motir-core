import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { CrossProjectSprintAssignmentError, SprintNotFoundError } from '@/lib/sprints/errors';
import { makeWorkItemFixture, createTestProject } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItemDto } from '@/lib/dto/workItems';

type One = [WorkItemDto];
type Two = [WorkItemDto, WorkItemDto];
type Three = [WorkItemDto, WorkItemDto, WorkItemDto];

// Integration tests for the Story-4.1 backlogService (Subtask 4.1.4): the
// issue↔sprint association writes, the single-row backlog-rank reorder, and the
// BOUNDED cursor-paginated reads. Real Postgres (no mocks), per CLAUDE.md. The
// at-SCALE bounded-read proof (`db:seed:large`) + the cross-cutting state-machine
// assertions are Story 4.1.5; here we prove the association/rank BEHAVIOUR + the
// finding-#26 tenancy gate + the create-time rank wiring.

/** Create `titles.length` backlog issues via the real create path (so each gets
 *  a create-time backlogRank appended), returning them in creation order — which
 *  is also their ascending rank order. */
async function createBacklog(fx: WorkItemFixture, titles: string[]) {
  const items = [];
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

/** The ids of a project's backlog page, in rank order (a generous limit). */
async function backlogIds(fx: WorkItemFixture): Promise<string[]> {
  const page = await backlogService.getBacklog(fx.projectId, { limit: 100 }, fx.ctx);
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

describe('backlogService.assignToSprint', () => {
  it('sets sprintId, removes the issue from the backlog, and records a 1.4.6 revision', async () => {
    const fx = await makeWorkItemFixture({ name: 'Assign' });
    const [a, b] = (await createBacklog(fx, ['A', 'B'])) as Two;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const before = await revisionCount(a.id);

    const updated = await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);

    expect(updated.sprintId).toBe(sprint.id);
    expect(await backlogIds(fx)).toEqual([b.id]); // A left the backlog
    const sprintPage = await backlogService.getSprintIssues(sprint.id, {}, fx.ctx);
    expect(sprintPage.items.map((i) => i.id)).toEqual([a.id]);
    expect(sprintPage.totalCount).toBe(1);
    expect(await revisionCount(a.id)).toBe(before + 1);
  });

  it('appends to the END of the sprint by default (Jira "drops at the bottom")', async () => {
    const fx = await makeWorkItemFixture({ name: 'Append' });
    const [a, c] = (await createBacklog(fx, ['A', 'C'])) as Two;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);

    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);
    await backlogService.assignToSprint(c.id, sprint.id, undefined, fx.ctx);

    const page = await backlogService.getSprintIssues(sprint.id, {}, fx.ctx);
    expect(page.items.map((i) => i.id)).toEqual([a.id, c.id]);
  });

  it('honours an explicit { beforeId, afterId } placement within the sprint', async () => {
    const fx = await makeWorkItemFixture({ name: 'Place' });
    const [a, b, c] = (await createBacklog(fx, ['A', 'B', 'C'])) as Three;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);
    await backlogService.assignToSprint(c.id, sprint.id, undefined, fx.ctx); // [A, C]

    await backlogService.assignToSprint(b.id, sprint.id, { beforeId: a.id, afterId: c.id }, fx.ctx);

    const page = await backlogService.getSprintIssues(sprint.id, {}, fx.ctx);
    expect(page.items.map((i) => i.id)).toEqual([a.id, b.id, c.id]); // B landed between
  });

  it('rejects a cross-project sprint assignment with the typed error', async () => {
    const fx = await makeWorkItemFixture({ name: 'XProj' });
    const [a] = (await createBacklog(fx, ['A'])) as One;
    // A second project in the SAME workspace, with its own sprint.
    const otherProject = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const otherSprint = await sprintsService.createSprint(otherProject.id, {}, fx.ctx);

    await expect(
      backlogService.assignToSprint(a.id, otherSprint.id, undefined, fx.ctx),
    ).rejects.toBeInstanceOf(CrossProjectSprintAssignmentError);
  });

  it('404s an unknown sprint and an unknown / cross-workspace issue', async () => {
    const fx = await makeWorkItemFixture({ name: 'Miss' });
    const [a] = (await createBacklog(fx, ['A'])) as One;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);

    await expect(
      backlogService.assignToSprint(a.id, 'sprint_nope', undefined, fx.ctx),
    ).rejects.toBeInstanceOf(SprintNotFoundError);
    await expect(
      backlogService.assignToSprint('wi_nope', sprint.id, undefined, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);

    // A different workspace cannot see this issue (finding #26 → 404).
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    await expect(
      backlogService.assignToSprint(a.id, sprint.id, undefined, other.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('backlogService.moveToBacklog', () => {
  it('nulls sprintId and restores the issue in backlog rank order; records a revision', async () => {
    const fx = await makeWorkItemFixture({ name: 'Back' });
    const [a, b] = (await createBacklog(fx, ['A', 'B'])) as Two;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);
    const before = await revisionCount(a.id);

    const updated = await backlogService.moveToBacklog(a.id, fx.ctx);

    expect(updated.sprintId).toBeNull();
    // A keeps its (low) create-time rank, so it sorts back ahead of B.
    expect(await backlogIds(fx)).toEqual([a.id, b.id]);
    expect(await revisionCount(a.id)).toBe(before + 1);
  });

  it('is a no-op (no revision) when the issue is already in the backlog', async () => {
    const fx = await makeWorkItemFixture({ name: 'NoopBack' });
    const [a] = (await createBacklog(fx, ['A'])) as One;
    const before = await revisionCount(a.id);

    const updated = await backlogService.moveToBacklog(a.id, fx.ctx);

    expect(updated.sprintId).toBeNull();
    expect(await revisionCount(a.id)).toBe(before); // unchanged
  });

  it('404s an unknown issue', async () => {
    const fx = await makeWorkItemFixture({ name: 'BackMiss' });
    await expect(backlogService.moveToBacklog('wi_nope', fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('backlogService.rankIssue', () => {
  it('moves an issue strictly between two neighbours with a SINGLE-row write', async () => {
    const fx = await makeWorkItemFixture({ name: 'Rank' });
    const [a, b, c] = (await createBacklog(fx, ['A', 'B', 'C'])) as Three; // order A,B,C
    const aRankBefore = (await workItemRepository.findById(a.id))!.backlogRank;
    const bRankBefore = (await workItemRepository.findById(b.id))!.backlogRank;

    await backlogService.rankIssue(c.id, { beforeId: a.id, afterId: b.id }, fx.ctx);

    expect(await backlogIds(fx)).toEqual([a.id, c.id, b.id]); // C now between A and B
    // Only C's rank changed (the fractional-index single-row guarantee).
    expect((await workItemRepository.findById(a.id))!.backlogRank).toBe(aRankBefore);
    expect((await workItemRepository.findById(b.id))!.backlogRank).toBe(bRankBefore);
  });

  it('handles the append edge case (only beforeId → after the last)', async () => {
    const fx = await makeWorkItemFixture({ name: 'RankApp' });
    const [a, b, c] = (await createBacklog(fx, ['A', 'B', 'C'])) as Three;
    await backlogService.rankIssue(a.id, { beforeId: c.id }, fx.ctx); // A → end
    expect(await backlogIds(fx)).toEqual([b.id, c.id, a.id]);
  });

  it('handles the prepend edge case (only afterId → before the first)', async () => {
    const fx = await makeWorkItemFixture({ name: 'RankPre' });
    const [a, b, c] = (await createBacklog(fx, ['A', 'B', 'C'])) as Three;
    await backlogService.rankIssue(c.id, { afterId: a.id }, fx.ctx); // C → top
    expect(await backlogIds(fx)).toEqual([c.id, a.id, b.id]);
  });

  it('is a no-op (no revision) when the placement resolves to the current rank', async () => {
    const fx = await makeWorkItemFixture({ name: 'RankNoop' });
    const [a, b, c] = (await createBacklog(fx, ['A', 'B', 'C'])) as Three;
    await backlogService.rankIssue(c.id, { beforeId: a.id, afterId: b.id }, fx.ctx);
    const after = await revisionCount(c.id);

    // keyBetween is deterministic — the same neighbours yield the same key.
    await backlogService.rankIssue(c.id, { beforeId: a.id, afterId: b.id }, fx.ctx);

    expect(await revisionCount(c.id)).toBe(after); // unchanged → no-op
  });

  it('404s an unknown named neighbour and an unknown issue', async () => {
    const fx = await makeWorkItemFixture({ name: 'RankMiss' });
    const [a] = (await createBacklog(fx, ['A'])) as One;
    await expect(
      backlogService.rankIssue(a.id, { beforeId: 'wi_nope' }, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(backlogService.rankIssue('wi_nope', {}, fx.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('backlogService.getBacklog (bounded reads, finding #57)', () => {
  it('cursor-paginates in rank order and never loads all rows; carries the total count', async () => {
    const fx = await makeWorkItemFixture({ name: 'Page' });
    const items = await createBacklog(fx, ['I0', 'I1', 'I2', 'I3', 'I4']);
    const ids = items.map((i) => i.id);

    const page1 = await backlogService.getBacklog(fx.projectId, { limit: 2 }, fx.ctx);
    expect(page1.items.map((i) => i.id)).toEqual([ids[0], ids[1]]);
    expect(page1.totalCount).toBe(5);
    expect(page1.nextCursor).toBe(ids[1]);

    const page2 = await backlogService.getBacklog(
      fx.projectId,
      { limit: 2, cursor: page1.nextCursor! },
      fx.ctx,
    );
    expect(page2.items.map((i) => i.id)).toEqual([ids[2], ids[3]]);
    expect(page2.nextCursor).toBe(ids[3]);

    const page3 = await backlogService.getBacklog(
      fx.projectId,
      { limit: 2, cursor: page2.nextCursor! },
      fx.ctx,
    );
    expect(page3.items.map((i) => i.id)).toEqual([ids[4]]);
    expect(page3.nextCursor).toBeNull(); // walked the whole ordering
  });

  it('excludes issues that are in a sprint (sprint_id IS NULL only)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Excl' });
    const [a, b] = (await createBacklog(fx, ['A', 'B'])) as Two;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);

    const page = await backlogService.getBacklog(fx.projectId, {}, fx.ctx);
    expect(page.items.map((i) => i.id)).toEqual([b.id]);
    expect(page.totalCount).toBe(1);
  });

  it('clamps a NaN / oversized limit to a sane default and is workspace-scoped', async () => {
    const fx = await makeWorkItemFixture({ name: 'Clamp' });
    await createBacklog(fx, ['A', 'B', 'C']);

    const nan = await backlogService.getBacklog(fx.projectId, { limit: Number.NaN }, fx.ctx);
    expect(nan.items).toHaveLength(3); // NaN → default page size (≥3)
    const big = await backlogService.getBacklog(fx.projectId, { limit: 100000 }, fx.ctx);
    expect(big.items).toHaveLength(3);

    // Another workspace sees an empty backlog for this project (finding #26).
    const other = await makeWorkItemFixture({ name: 'ClampOther', identifier: 'OTH' });
    const denied = await backlogService.getBacklog(fx.projectId, {}, other.ctx);
    expect(denied.items).toEqual([]);
    expect(denied.totalCount).toBe(0);
  });
});

describe('backlogService.getSprintIssues', () => {
  it('returns the sprint ranked issues + count', async () => {
    const fx = await makeWorkItemFixture({ name: 'SprIss' });
    const [a, b] = (await createBacklog(fx, ['A', 'B'])) as Two;
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);
    await backlogService.assignToSprint(b.id, sprint.id, undefined, fx.ctx);

    const page = await backlogService.getSprintIssues(sprint.id, {}, fx.ctx);
    expect(page.items.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(page.totalCount).toBe(2);
    expect(page.nextCursor).toBeNull();
  });

  it('404s an unknown / cross-workspace sprint', async () => {
    const fx = await makeWorkItemFixture({ name: 'SprMiss' });
    await expect(backlogService.getSprintIssues('sprint_nope', {}, fx.ctx)).rejects.toBeInstanceOf(
      SprintNotFoundError,
    );
  });
});

describe('create-time backlog rank (workItemsService.createWorkItem wiring)', () => {
  it('appends a non-null backlogRank to every new issue, total from creation', async () => {
    const fx = await makeWorkItemFixture({ name: 'CreateRank' });
    const [a, b] = (await createBacklog(fx, ['A', 'B'])) as Two;

    const ra = (await workItemRepository.findById(a.id))!.backlogRank;
    const rb = (await workItemRepository.findById(b.id))!.backlogRank;
    expect(ra).not.toBeNull();
    expect(rb).not.toBeNull();
    expect(ra! < rb!).toBe(true); // appended in creation order
    expect(await backlogIds(fx)).toEqual([a.id, b.id]);
  });
});
