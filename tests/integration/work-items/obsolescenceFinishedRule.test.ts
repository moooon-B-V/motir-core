import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  MarkedCardCannotReopenError,
  ObsolescenceRequiresFinishedError,
} from '@/lib/workItems/errors';
import { isStatusTransitionRefusal } from '@/lib/workItems/statusTransitionRefusals';
import type { WorkItemKindDto, WorkItemObsolescenceDto } from '@/lib/dto/workItems';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { dispatchedEvents, spyOnJobDispatch } from '../../helpers/jobs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// Story MOTIR-6575 · MOTIR-6672 — A MARKED CARD STAYS FINISHED, driven through
// workItemsService against a REAL Postgres. The service layer is where every door
// converges, so this pins the rule once for all of them (the doors' own wire
// shapes are MOTIR-6673's):
//   • a mark is SET only on a card whose status sits in the `done` CATEGORY —
//     `done`, `cancelled`, or a custom done-category status — else
//     OBSOLESCENCE_REQUIRES_FINISHED; clearing and omitting are always legal;
//   • `applyStatusTransition` refuses a marked card's move out of the done
//     category with MARKED_CARD_CANNOT_REOPEN, system moves included, writing no
//     revision and emitting nothing; `done ↔ cancelled` and the no-op stay legal;
//   • no new work under a marked card: create, re-parent through update, and
//     `moveWorkItem` all refuse; filing into a folder is untouched.

const DB_TEST_TIMEOUT_MS = 30_000;

let fx: WorkItemFixture;
let jobSpy: ReturnType<typeof spyOnJobDispatch>;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  jobSpy = spyOnJobDispatch();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function create(kind: WorkItemKindDto = 'task', parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title: `A ${kind}`, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function statusOf(id: string): Promise<string> {
  return (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
}

async function revisionCount(workItemId: string): Promise<number> {
  return adminDb.workItemRevision.count({ where: { workItemId } });
}

/** A card at `status` carrying `mark`, set behind the service's back. */
async function marked(
  mark: WorkItemObsolescenceDto,
  status = 'done',
  kind: WorkItemKindDto = 'task',
) {
  const item = await create(kind);
  await adminDb.workItem.update({ where: { id: item.id }, data: { status, obsolescence: mark } });
  return item;
}

async function transition(id: string, to: string, system: boolean) {
  return withWorkspaceContext(fx.ctx, (tx) =>
    workItemsService.applyStatusTransition(id, to, fx.ctx, tx, { system }),
  );
}

describe('rule 1 — a mark is set only on a finished card', () => {
  it.each(['todo', 'blocked', 'in_progress', 'in_review'])(
    'update refuses both marks on a card at %s, writing nothing',
    async (status) => {
      const task = await create();
      await setStatus(task.id, status);
      const before = await revisionCount(task.id);
      for (const mark of ['outdated', 'deprecated'] as const) {
        const err = await workItemsService
          .updateWorkItem(task.id, { obsolescence: mark, obsolescenceNoteMd: 'no' }, fx.ctx)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ObsolescenceRequiresFinishedError);
        expect(err).toMatchObject({
          code: 'OBSOLESCENCE_REQUIRES_FINISHED',
          key: task.identifier,
          statusKey: status,
        });
        expect((err as Error).message).toContain('archived, not marked');
      }
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: task.id } });
      expect(row.obsolescence).toBeNull();
      expect(row.obsolescenceNoteMd).toBeNull();
      expect(await revisionCount(task.id)).toBe(before);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it.each(['done', 'cancelled'])(
    'update accepts both marks on a card at %s',
    async (status) => {
      const task = await create();
      await setStatus(task.id, status);
      const outdated = await workItemsService.updateWorkItem(
        task.id,
        { obsolescence: 'outdated' },
        fx.ctx,
      );
      expect(outdated.obsolescence).toBe('outdated');
      const deprecated = await workItemsService.updateWorkItem(
        task.id,
        { obsolescence: 'deprecated' },
        fx.ctx,
      );
      expect(deprecated.obsolescence).toBe('deprecated');
      expect(deprecated.status).toBe(status);
    },
    DB_TEST_TIMEOUT_MS,
  );

  it('treats a CUSTOM done-category status as finished (a `shipped` workflow)', async () => {
    await adminDb.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'shipped',
        label: 'Shipped',
        category: 'done',
        position: 'z9',
      },
    });
    const task = await create();
    await setStatus(task.id, 'shipped');
    const updated = await workItemsService.updateWorkItem(
      task.id,
      { obsolescence: 'outdated' },
      fx.ctx,
    );
    expect(updated.obsolescence).toBe('outdated');
  });

  it('clearing is legal on ANY status, and an update that omits the mark never refuses', async () => {
    // A legacy unfinished marked card (written before this rule): the story does
    // not migrate rows, so the guards act on writes only.
    const legacy = await marked('deprecated', 'todo');
    const renamed = await workItemsService.updateWorkItem(
      legacy.id,
      { title: 'Renamed', obsolescenceNoteMd: 'Why.' },
      fx.ctx,
    );
    expect(renamed.obsolescence).toBe('deprecated');
    const cleared = await workItemsService.updateWorkItem(
      legacy.id,
      { obsolescence: null },
      fx.ctx,
    );
    expect(cleared.obsolescence).toBeNull();
  });
});

describe('rule 2 — a marked card cannot be reopened', () => {
  it.each([
    ['outdated', false],
    ['outdated', true],
    ['deprecated', false],
    ['deprecated', true],
  ] as const)(
    'refuses a %s card’s move to every unfinished status (system: %s), writing and emitting nothing',
    async (mark, system) => {
      const task = await marked(mark);
      const before = await revisionCount(task.id);
      jobSpy.mockClear();
      for (const to of ['todo', 'in_progress', 'in_review']) {
        const err = await transition(task.id, to, system).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MarkedCardCannotReopenError);
        expect(err).toMatchObject({
          code: 'MARKED_CARD_CANNOT_REOPEN',
          key: task.identifier,
          obsolescence: mark,
          toStatusKey: to,
        });
        expect((err as Error).message).toContain('clear the mark to reopen this item');
        expect(isStatusTransitionRefusal(err)).toBe(true);
      }
      expect(await statusOf(task.id)).toBe('done');
      expect(await revisionCount(task.id)).toBe(before);
      expect(dispatchedEvents(jobSpy).map((e) => e.name)).not.toContain('work-item/transitioned');
    },
    DB_TEST_TIMEOUT_MS,
  );

  it('refuses the interactive door too — updateStatus', async () => {
    const task = await marked('outdated');
    await expect(workItemsService.updateStatus(task.id, 'todo', fx.ctx)).rejects.toBeInstanceOf(
      MarkedCardCannotReopenError,
    );
    expect(await statusOf(task.id)).toBe('done');
    expect(dispatchedEvents(jobSpy).map((e) => e.name)).not.toContain('work-item/transitioned');
  });

  it('allows done → cancelled → done, and the no-op move', async () => {
    // The default workflow draws no `done ↔ cancelled` edge, so a SYSTEM move
    // (no edge check) is what reaches it — and proves the mark does not hold it.
    const task = await marked('deprecated');
    await transition(task.id, 'cancelled', true);
    expect(await statusOf(task.id)).toBe('cancelled');
    await transition(task.id, 'done', true);
    expect(await statusOf(task.id)).toBe('done');
    const noop = await transition(task.id, 'done', false);
    expect(noop.transition).toBeNull();
  });

  it('after the mark is cleared the same move reopens the card', async () => {
    const task = await marked('outdated');
    await expect(workItemsService.updateStatus(task.id, 'in_progress', fx.ctx)).rejects.toThrow();
    await workItemsService.updateWorkItem(task.id, { obsolescence: null }, fx.ctx);
    await workItemsService.updateStatus(task.id, 'in_progress', fx.ctx);
    expect(await statusOf(task.id)).toBe('in_progress');
  });

  it('a custom done-category target is not a reopen', async () => {
    await adminDb.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'shipped',
        label: 'Shipped',
        category: 'done',
        position: 'z9',
      },
    });
    const task = await marked('outdated');
    await transition(task.id, 'shipped', true);
    expect(await statusOf(task.id)).toBe('shipped');
  });
});

describe('rule 5 — no new work under a marked card', () => {
  it('refuses to create a child under a marked story, and the story stays done', async () => {
    const story = await marked('outdated', 'done', 'story');
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    const err = await create('subtask', story.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarkedCardCannotReopenError);
    expect(err).toMatchObject({ key: story.identifier, toStatusKey: null });
    expect((err as Error).message).toContain('a new child');
    expect(await adminDb.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
    expect(await statusOf(story.id)).toBe('done');
  });

  it('refuses re-parenting a card under a marked story through update', async () => {
    const story = await marked('deprecated', 'done', 'story');
    const task = await create('task');
    const err = await workItemsService
      .updateWorkItem(task.id, { parentId: story.id }, fx.ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MarkedCardCannotReopenError);
    expect((err as Error).message).toContain(task.identifier);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: task.id } })).parentId).toBe(
      null,
    );
    expect(await statusOf(story.id)).toBe('done');
  });

  it('refuses moveWorkItem under a marked story', async () => {
    const story = await marked('outdated', 'done', 'story');
    const task = await create('task');
    await expect(
      workItemsService.moveWorkItem(task.id, { newParentId: story.id }, fx.ctx),
    ).rejects.toBeInstanceOf(MarkedCardCannotReopenError);
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: task.id } })).parentId).toBe(
      null,
    );
  });

  it('still allows work under an UNMARKED done story, and filing a card into a folder', async () => {
    const story = await create('story');
    await setStatus(story.id, 'done');
    const child = await create('subtask', story.id);
    expect(child.parentId).toBe(story.id);

    const folder = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Retired' },
      fx.ctx,
    );
    const legacy = await marked('deprecated');
    const filed = await foldersService.fileWorkItem(legacy.id, { folderId: folder.id }, fx.ctx);
    expect(filed).toBeTruthy();
  });
});
