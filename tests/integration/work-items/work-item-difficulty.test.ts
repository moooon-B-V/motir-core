import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { DifficultyNotAllowedOnKindError } from '@/lib/workItems/errors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';

// Story MOTIR-6016 · MOTIR-6096 — the work-item DIFFICULTY column, driven
// through workItemsService against a REAL Postgres. Pins the service contract
// every later door (REST, MCP, the item page, the filter) writes through:
//   • persisted on a leaf, null when omitted, carried on the DTO;
//   • leaf-only by KIND — refused on an epic/story with its OWN code, including
//     a kind change onto a container that keeps one;
//   • every change recorded as a `difficulty` revision cell, and a re-send of
//     the current value recording nothing.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

async function revisionDiffs(workItemId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await adminDb.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
    select: { diff: true },
  });
  return rows.map((r) => r.diff as Record<string, unknown>);
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('createWorkItem — difficulty', () => {
  it.each(['subtask', 'task', 'bug'] as const)('persists a difficulty on a %s', async (kind) => {
    const fx = await makeWorkItemFixture();
    const parent =
      kind === 'subtask'
        ? await workItemsService.createWorkItem(
            { projectId: fx.projectId, kind: 'story', title: 'Story' },
            fx.ctx,
          )
        : null;
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind,
        title: 'Reorder the lock acquisition',
        difficulty: 'high',
        ...(parent ? { parentId: parent.id } : {}),
      },
      fx.ctx,
    );
    expect(item.difficulty).toBe('high');

    const row = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findById(item.id, tx),
    );
    expect(row?.difficulty).toBe('high');
    // The created revision records the initial value.
    expect((await revisionDiffs(item.id))[0]?.['difficulty']).toEqual({ from: null, to: 'high' });
  });

  it('persists null and carries `difficulty: null` when omitted — and records no cell', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'No difficulty' },
      fx.ctx,
    );
    expect(task.difficulty).toBeNull();
    const row = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findById(task.id, tx),
    );
    expect(row?.difficulty).toBeNull();
    expect((await revisionDiffs(task.id))[0]).not.toHaveProperty('difficulty');
  });

  it.each(['epic', 'story'] as const)(
    'refuses a difficulty on a %s and writes nothing',
    async (kind) => {
      const fx = await makeWorkItemFixture();
      await expect(
        workItemsService.createWorkItem(
          { projectId: fx.projectId, kind, title: 'Container', difficulty: 'low' },
          fx.ctx,
        ),
      ).rejects.toBeInstanceOf(DifficultyNotAllowedOnKindError);
      expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(0);
    },
  );

  it('accepts an explicit null on a story', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Container', difficulty: null },
      fx.ctx,
    );
    expect(story.difficulty).toBeNull();
  });
});

describe('updateWorkItem — difficulty', () => {
  it('records medium → high as one revision cell, and a re-send records nothing', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Change it', difficulty: 'medium' },
      fx.ctx,
    );

    const updated = await workItemsService.updateWorkItem(task.id, { difficulty: 'high' }, fx.ctx);
    expect(updated.difficulty).toBe('high');
    let diffs = await revisionDiffs(task.id);
    expect(diffs).toHaveLength(2);
    expect(diffs[1]).toEqual({ difficulty: { from: 'medium', to: 'high' } });

    // Sending the current value is not a change.
    const same = await workItemsService.updateWorkItem(task.id, { difficulty: 'high' }, fx.ctx);
    expect(same.difficulty).toBe('high');
    diffs = await revisionDiffs(task.id);
    expect(diffs).toHaveLength(2);
  });

  it('clears a difficulty with null', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Clear it', difficulty: 'low' },
      fx.ctx,
    );
    const cleared = await workItemsService.updateWorkItem(task.id, { difficulty: null }, fx.ctx);
    expect(cleared.difficulty).toBeNull();
    expect((await revisionDiffs(task.id)).at(-1)).toEqual({
      difficulty: { from: 'low', to: null },
    });
  });

  it('refuses setting a difficulty on a story, but accepts null', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story' },
      fx.ctx,
    );
    await expect(
      workItemsService.updateWorkItem(story.id, { difficulty: 'medium' }, fx.ctx),
    ).rejects.toMatchObject({ code: 'DIFFICULTY_NOT_ALLOWED_ON_KIND' });

    const unchanged = await workItemsService.updateWorkItem(story.id, { difficulty: null }, fx.ctx);
    expect(unchanged.difficulty).toBeNull();
  });

  it('refuses converting a leaf that carries a difficulty into a story unless the same update clears it', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const task = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Becomes a story',
        parentId: epic.id,
        difficulty: 'medium',
      },
      fx.ctx,
    );

    await expect(
      workItemsService.updateWorkItem(task.id, { kind: 'story' }, fx.ctx),
    ).rejects.toBeInstanceOf(DifficultyNotAllowedOnKindError);
    const still = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRepository.findById(task.id, tx),
    );
    expect(still?.kind).toBe('task');
    expect(still?.difficulty).toBe('medium');

    const converted = await workItemsService.updateWorkItem(
      task.id,
      { kind: 'story', difficulty: null },
      fx.ctx,
    );
    expect(converted.kind).toBe('story');
    expect(converted.difficulty).toBeNull();
  });
});
