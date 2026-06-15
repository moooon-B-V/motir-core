import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { aiBoundaryService } from '@/lib/services/aiBoundaryService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PlanDeltaValidationError } from '@/lib/ai/planDelta';
import { makeWorkItemFixture as makeFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 7.1.6 — the ai→core read-back + persist surface against a REAL
// Postgres. Proves the skeleton read projects the token's project, the delta
// commits through workItemsService (the SAME create path the UI uses), the
// empty delta is a no-op, and the cross-tenant gate is a 404 (finding #26).

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

  it('reads a foreign project as 404 (ProjectNotFoundError), not 403', async () => {
    const a = await makeFixture();
    const b = await makeFixture(); // a different workspace + project
    await expect(aiBoundaryService.readPlanTree(b.projectId, a.ctx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});

describe('aiBoundaryService.commitPlanDelta', () => {
  it('is a no-op for an empty delta', async () => {
    const fx = await makeFixture();
    const result = await aiBoundaryService.commitPlanDelta(
      fx.projectId,
      { operations: [] },
      fx.ctx,
    );
    expect(result.applied).toEqual([]);
    const tree = await aiBoundaryService.readPlanTree(fx.projectId, fx.ctx);
    expect(tree.items).toHaveLength(0);
  });

  it('creates a work item under an existing parent (the same path the UI uses)', async () => {
    const fx = await makeFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );

    const result = await aiBoundaryService.commitPlanDelta(
      fx.projectId,
      {
        operations: [
          {
            op: 'create',
            ref: 's1',
            parentKey: epic.identifier,
            kind: 'story',
            fields: { title: 'New story', estimateMinutes: 60 },
          },
        ],
      },
      fx.ctx,
    );

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ op: 'create', ref: 's1' });
    const newKey = result.applied[0]!.key;

    const tree = await aiBoundaryService.readPlanTree(fx.projectId, fx.ctx);
    const created = tree.items.find((i) => i.key === newKey);
    expect(created).toMatchObject({ title: 'New story', parentKey: epic.identifier });
  });

  it('rejects a create whose parentKey does not exist', async () => {
    const fx = await makeFixture();
    await expect(
      aiBoundaryService.commitPlanDelta(
        fx.projectId,
        {
          operations: [
            { op: 'create', parentKey: 'MOTIR-9999', kind: 'story', fields: { title: 'x' } },
          ],
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlanDeltaValidationError);
  });
});
