import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { TypeNotAllowedOnKindError } from '@/lib/workItems/errors';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture } from '../../fixtures';

// Subtask 2.7.3 — the work-item TYPE + EXECUTOR fields, driven through
// workItemsService against a REAL Postgres (Yue's no-mocks rule). Covers the
// new service branches this Subtask adds:
//   • leaf-only enforcement (type/executor rejected on epic/story, allowed on
//     task/subtask/bug) — the primary guard (no DB trigger backstop);
//   • executor seed-if-absent (a type chosen without an executor seeds the
//     default; an explicit executor / an existing override is never clobbered);
//   • create + update + clear + the typed-leaf→container conversion guard.
// (Subtask 2.7.7 adds the broader lock-down incl. the loader mapping + filter
// facet; this pins the schema + service contract at the source.)

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

describe('createWorkItem — type + executor', () => {
  it('seeds the executor from the type default when a type is given without one', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Wire the form', type: 'code' },
      fx.ctx,
    );
    expect(task.type).toBe('code');
    expect(task.executor).toBe('coding_agent');

    // Verified by a repository read — the STRUCTURED columns are set, not prose.
    const row = await workItemRepository.findById(task.id);
    expect(row?.type).toBe('code');
    expect(row?.executor).toBe('coding_agent');
  });

  it('seeds human for a manual type', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Provision Blob store', type: 'manual' },
      fx.ctx,
    );
    expect(task.executor).toBe('human');
  });

  it('honors an explicit executor override (overriding the default)', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Hand-author the migration',
        type: 'design',
        executor: 'human',
      },
      fx.ctx,
    );
    expect(task.type).toBe('design');
    expect(task.executor).toBe('human'); // not the 'coding_agent' default
  });

  it('leaves type + executor null on an untyped leaf', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Untyped' },
      fx.ctx,
    );
    expect(task.type).toBeNull();
    expect(task.executor).toBeNull();
  });

  it('rejects a type on an epic (leaf-only)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'epic', title: 'Container', type: 'code' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(TypeNotAllowedOnKindError);
  });

  it('rejects an executor on a story even without a type', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'Container', executor: 'human' },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'TYPE_NOT_ALLOWED_ON_KIND' });
  });
});

describe('updateWorkItem — type + executor', () => {
  it('seeds the executor when a type is first set on an untyped leaf', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Later-typed' },
      fx.ctx,
    );
    const updated = await workItemsService.updateWorkItem(task.id, { type: 'test' }, fx.ctx);
    expect(updated.type).toBe('test');
    expect(updated.executor).toBe('coding_agent');
  });

  it('does NOT clobber an existing executor on a bare type change', async () => {
    const fx = await makeWorkItemFixture();
    // design defaults coding_agent; override to human.
    const task = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Override kept',
        type: 'design',
        executor: 'human',
      },
      fx.ctx,
    );
    // Patch only the type to code (whose default is coding_agent) — executor stays human.
    const updated = await workItemsService.updateWorkItem(task.id, { type: 'code' }, fx.ctx);
    expect(updated.type).toBe('code');
    expect(updated.executor).toBe('human');
  });

  it('applies an explicit executor override on update', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Reassign', type: 'code' },
      fx.ctx,
    );
    expect(task.executor).toBe('coding_agent');
    const updated = await workItemsService.updateWorkItem(task.id, { executor: 'human' }, fx.ctx);
    expect(updated.executor).toBe('human');
  });

  it('clears the type with an explicit null', async () => {
    const fx = await makeWorkItemFixture();
    const task = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Untype me',
        type: 'code',
        executor: 'human',
      },
      fx.ctx,
    );
    const updated = await workItemsService.updateWorkItem(
      task.id,
      { type: null, executor: null },
      fx.ctx,
    );
    expect(updated.type).toBeNull();
    expect(updated.executor).toBeNull();
  });

  it('rejects setting a type on a story', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );
    await expect(
      workItemsService.updateWorkItem(story.id, { type: 'code' }, fx.ctx),
    ).rejects.toBeInstanceOf(TypeNotAllowedOnKindError);
  });

  it('rejects converting a typed leaf into a story without clearing its type, but allows it when both are cleared', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const task = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Will convert',
        type: 'code',
        parentId: epic.id,
      },
      fx.ctx,
    );
    // Convert task → story WITHOUT clearing the type: the leaf-only invariant
    // would be violated (a story carrying a type), so it's rejected.
    await expect(
      workItemsService.updateWorkItem(task.id, { kind: 'story' }, fx.ctx),
    ).rejects.toBeInstanceOf(TypeNotAllowedOnKindError);

    // Clearing type + executor in the SAME patch makes the conversion legal.
    const converted = await workItemsService.updateWorkItem(
      task.id,
      { kind: 'story', type: null, executor: null },
      fx.ctx,
    );
    expect(converted.kind).toBe('story');
    expect(converted.type).toBeNull();
    expect(converted.executor).toBeNull();
  });
});
