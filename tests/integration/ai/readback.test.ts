import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 7.1.6 — the ai→core READ-back surface against a REAL Postgres. Proves
// the skeleton read projects the token's project (parentKey resolved) and the
// cross-tenant gate is a 404, never 403 (finding #26).
//
// The WRITE side (`commitPlanDelta`) was REMOVED by 7.4.4 (MOTIR-846) — generation
// no longer buffers a whole delta; it appends incremental `add` PlanItem proposals
// (see tests/integration/ai/generation*.test.ts).

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

describe('aiBoundaryService.readPlanTree', () => {
  it('returns the skeleton projection for the token project, parentKey resolved', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Auth' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Login', parentId: epic.id },
      fx.ctx,
    );

    const tree = await aiBoundaryService.readPlanTree(fx.projectId, fx.ctx);

    expect(tree.project.projectId).toBe(fx.projectId);
    const byKey = new Map(tree.items.map((i) => [i.key, i]));
    expect(byKey.get(epic.identifier)).toMatchObject({ kind: 'epic', parentKey: null });
    expect(byKey.get(story.identifier)).toMatchObject({
      kind: 'story',
      title: 'Login',
      parentKey: epic.identifier,
    });
  });

  // MOTIR-1531 — the breadth read carries the real `id` + latest `revision` anchor
  // (from ONE batched lookup) so a generator can emit a modify/remove PlanItem with
  // a resolvable `workItemId` + `baseRevision` without a per-target `get-item`.
  it('carries the real id + latest revision, and revision tracks a subsequent edit', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Auth' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Login', parentId: epic.id },
      fx.ctx,
    );

    const before = await aiBoundaryService.readPlanTree(fx.projectId, fx.ctx);
    const storyRowBefore = before.items.find((i) => i.key === story.identifier)!;

    // The row's `id` is the real cuid (not the key), and its `revision` equals the
    // item's latest `work_item_revision.id` — the `created` revision at this point.
    expect(storyRowBefore.id).toBe(story.id);
    const latestBefore = await workItemRevisionRepository.findLatestIdsByWorkItemIds([story.id]);
    expect(storyRowBefore.revision).toBe(latestBefore.get(story.id));
    expect(storyRowBefore.revision).not.toBeNull();

    // Editing the item records a NEW revision → the projected `revision` advances
    // to the new latest id (the drift signal 7.21.3 compares `baseRevision` to).
    await workItemsService.updateWorkItem(story.id, { title: 'Sign in' }, fx.ctx);

    const after = await aiBoundaryService.readPlanTree(fx.projectId, fx.ctx);
    const storyRowAfter = after.items.find((i) => i.key === story.identifier)!;
    const latestAfter = await workItemRevisionRepository.findLatestIdsByWorkItemIds([story.id]);

    expect(storyRowAfter.id).toBe(story.id);
    expect(storyRowAfter.revision).toBe(latestAfter.get(story.id));
    expect(storyRowAfter.revision).not.toBe(storyRowBefore.revision);
  });

  it('reads a foreign project as 404 (ProjectNotFoundError), not 403', async () => {
    const a = await makeFixture();
    const b = await makeFixture(); // a different workspace + project
    await expect(aiBoundaryService.readPlanTree(b.projectId, a.ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});
