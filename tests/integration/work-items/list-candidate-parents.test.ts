import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { IllegalParentTypeError } from '@/lib/workItems/errors';
import type { IssueType } from '@/lib/issues/parentRules';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture as makeFixture, type WorkItemFixture } from '../../fixtures';

// workItemsService.listCandidateParents (Subtask 2.3.4) against a REAL Postgres.
// Proves the parent picker's candidate set is exactly the legal parents for a
// childType (the inverted 2.1.2 matrix), excludes archived, is workspace-scoped
// (finding #26), and that the create gate still rejects a forged illegal parent
// even though the UI pre-filters (defense in depth).

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

// A legal tree: epic E (root), story/task/bug under E, subtask under the story.
async function seedTree(fx: WorkItemFixture) {
  const E = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
    fx.ctx,
  );
  const S = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: E.id },
    fx.ctx,
  );
  const T = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Task', parentId: E.id },
    fx.ctx,
  );
  const B = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'bug', title: 'Bug', parentId: E.id },
    fx.ctx,
  );
  const SUB = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'subtask', title: 'Subtask', parentId: S.id },
    fx.ctx,
  );
  return { E, S, T, B, SUB };
}

describe('workItemsService.listCandidateParents', () => {
  it('returns exactly the legal parents for every childType (the inverted matrix)', async () => {
    const fx = await makeFixture();
    const { E, S, T, B } = await seedTree(fx);
    const ids = async (childType: IssueType) =>
      (await workItemsService.listCandidateParents(fx.projectId, childType, fx.workspaceId))
        .map((c) => c.id)
        .sort();

    expect(await ids('story')).toEqual([E.id].sort()); // epic only
    expect(await ids('task')).toEqual([E.id, S.id].sort()); // epic, story
    expect(await ids('bug')).toEqual([E.id, S.id, T.id].sort()); // epic, story, task
    expect(await ids('subtask')).toEqual([S.id, T.id, B.id].sort()); // story, task, bug
    expect(await ids('epic')).toEqual([]); // root only — no legal parent
  });

  it('excludes archived candidates', async () => {
    const fx = await makeFixture();
    const { S, T, B } = await seedTree(fx);
    await workItemsService.archiveWorkItem(B.id, fx.ctx);
    const got = (
      await workItemsService.listCandidateParents(fx.projectId, 'subtask', fx.workspaceId)
    )
      .map((c) => c.id)
      .sort();
    expect(got).toEqual([S.id, T.id].sort()); // the archived bug is gone
  });

  it('is workspace-scoped: a foreign workspaceId returns [] (finding #26)', async () => {
    const fx = await makeFixture();
    await seedTree(fx);
    const got = await workItemsService.listCandidateParents(
      fx.projectId,
      'subtask',
      'some-other-workspace-id',
    );
    expect(got).toEqual([]);
  });

  it('defense-in-depth: createWorkItem still rejects a forged illegal parent (epic cannot hold a subtask)', async () => {
    const fx = await makeFixture();
    const { E } = await seedTree(fx);
    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'subtask', title: 'Forged', parentId: E.id },
        fx.ctx,
      ),
    ).rejects.toThrow(IllegalParentTypeError);
  });
});
