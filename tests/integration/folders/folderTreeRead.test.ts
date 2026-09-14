import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';
import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { FolderNotFoundError } from '@/lib/folders/errors';
import { DEFAULT_SORT, type IssueSort } from '@/lib/issues/issueListView';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  createTestWorkItem as createWorkItem,
  makeWorkItemFixture as makeFixture,
  type WorkItemFixture,
} from '../../fixtures';

// The TREE READ with folders (Story MOTIR-5308 · MOTIR-5314) on a real Postgres:
// `workItemsService.listRootIssues` / `listFolderLevel` over
// `folderRepository.findLevel` and `workItemRepository.findProjectTreeLevel`.
//
// What the card asks this file to prove, and where:
//   1  a level is its folders THEN its work items, at the root and inside a
//      folder, with a correct `hasChildren` on every folder  → 'a level'
//   1a the project ROOT reads its epics, then its folders, then its other work
//      items, and a sort reorders within the epic and work-item bands only
//      (MOTIR-5550)  → 'the project root'
//   2  one take/offset walks the root's three bands with no row repeated or
//      skipped  → 'paging across the boundary'
//   3  a filed item appears at the /items root in no read, and the sprint arm
//      excludes it when asked — while the roadmap's read, which does not ask,
//      still returns it (the amendment on MOTIR-5314)  → 'filed items leave the root'
//   4  an archived or triaged filed item is not in its folder's level and does
//      not make `hasChildren` true on its own  → 'exclusions'
//   The existing tree tests (tree-lazy-read, project-tree) are the "unchanged
//   for a project with no folders" half, and run beside this file.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const sort = (): IssueSort => ({ ...DEFAULT_SORT });

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

function file(fx: WorkItemFixture, workItemId: string, folderId: string) {
  return foldersService.fileWorkItem(workItemId, { folderId }, fx.ctx);
}

describe('a level', () => {
  it('is its folders then its work items inside each folder, and at a root with no epics', async () => {
    const fx = await makeFixture();
    // Every project is born with a Bugs folder (MOTIR-4935), so it is part of this read.
    const bugs = await seededBugsFolderId(fx.projectId);
    const outer = await folder(fx, 'Outer');
    const second = await folder(fx, 'Second');
    const nested = await folder(fx, 'Nested', outer.id);
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Filed epic' });
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });
    const task = await createWorkItem(fx, { kind: 'task', title: 'Task' });
    const bug = await createWorkItem(fx, { kind: 'bug', title: 'Bug' });
    const loose = await createWorkItem(fx, { kind: 'story', title: 'Loose story' });
    await file(fx, epic.id, nested.id);

    const root = await workItemsService.listRootIssues(fx.projectId, { sort: sort() }, fx.ctx);
    expect(root.rows.map((r) => r.id)).toEqual([
      bugs,
      outer.id,
      second.id,
      task.id,
      bug.id,
      loose.id,
    ]);
    expect(root.rows.map((r) => r.kind)).toEqual([
      'folder',
      'folder',
      'folder',
      'task',
      'bug',
      'story',
    ]);
    expect(root.rows.find((r) => r.id === outer.id)?.hasChildren).toBe(true);
    expect(root.rows.find((r) => r.id === second.id)?.hasChildren).toBe(false);
    expect(root).toMatchObject({ total: 6, hasMore: false });

    const inOuter = await workItemsService.listFolderLevel(outer.id, { sort: sort() }, fx.ctx);
    expect(inOuter.rows).toEqual([
      {
        kind: 'folder',
        id: nested.id,
        parentId: null,
        parentFolderId: outer.id,
        name: 'Nested',
        position: nested.position,
        hasChildren: true,
      },
    ]);
    expect(inOuter.total).toBe(1);

    const inNested = await workItemsService.listFolderLevel(nested.id, { sort: sort() }, fx.ctx);
    expect(inNested.rows.map((r) => r.id)).toEqual([epic.id]);
    expect(inNested.rows[0]?.hasChildren).toBe(true);

    // The empty folder's level is empty, and a work item's children read as before.
    expect(await workItemsService.listFolderLevel(second.id, { sort: sort() }, fx.ctx)).toEqual({
      rows: [],
      hasMore: false,
      total: 0,
      workItemTotal: 0,
    });
    const children = await workItemsService.listChildIssues(epic.id, { sort: sort() }, fx.ctx);
    expect(children.rows.map((r) => r.id)).toEqual([story.id]);
  });

  it('refuses a folder that does not exist or belongs to another workspace', async () => {
    const fx = await makeFixture();
    const later = await folder(fx, 'Later');
    await expect(
      workItemsService.listFolderLevel('no-such-folder', { sort: sort() }, fx.ctx),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
    await expect(
      workItemsService.listFolderLevel(
        later.id,
        { sort: sort() },
        { ...fx.ctx, workspaceId: 'another-workspace' },
      ),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
  });
});

describe('the project root', () => {
  it('reads its epics, then its folders, then its other work items, and a sort moves rows only within a band', async () => {
    const fx = await makeFixture();
    // Every project is born with a Bugs folder (MOTIR-4935), so it is part of this read.
    const bugs = await seededBugsFolderId(fx.projectId);
    // Created interleaved, so neither key order nor creation order yields the bands.
    const task = await createWorkItem(fx, { kind: 'task', title: 'Alpha task' });
    const zulu = await createWorkItem(fx, { kind: 'epic', title: 'Zulu epic' });
    const later = await folder(fx, 'Later');
    const bug = await createWorkItem(fx, { kind: 'bug', title: 'Mike bug' });
    const alpha = await createWorkItem(fx, { kind: 'epic', title: 'Alpha epic' });
    // Named to sort FIRST by name, and created last: folders keep their position.
    const aardvark = await folder(fx, 'Aardvark');
    const story = await createWorkItem(fx, { kind: 'story', title: 'Bravo story' });
    const folders = [bugs, later.id, aardvark.id];

    const byKey = await workItemsService.listRootIssues(fx.projectId, { sort: sort() }, fx.ctx);
    expect(byKey.rows.map((r) => r.id)).toEqual([
      zulu.id,
      alpha.id,
      ...folders,
      task.id,
      bug.id,
      story.id,
    ]);
    expect(byKey).toMatchObject({ total: 8, workItemTotal: 5, hasMore: false });

    const byTitle = await workItemsService.listRootIssues(
      fx.projectId,
      { sort: { column: 'title', direction: 'asc' } },
      fx.ctx,
    );
    expect(byTitle.rows.map((r) => r.id)).toEqual([
      alpha.id,
      zulu.id,
      ...folders,
      task.id,
      story.id,
      bug.id,
    ]);
    expect(byTitle).toMatchObject({ total: 8, workItemTotal: 5, hasMore: false });
  });

  it('counts its work items apart from its folders — a new project holds one folder and none (MOTIR-5541)', async () => {
    const fx = await makeFixture();
    const bugs = await seededBugsFolderId(fx.projectId);
    const root = () => workItemsService.listRootIssues(fx.projectId, { sort: sort() }, fx.ctx);

    expect(await root()).toEqual({
      rows: [expect.objectContaining({ kind: 'folder', id: bugs })],
      hasMore: false,
      total: 1,
      workItemTotal: 0,
    });

    // An item filed into a folder is that folder's, not the root's.
    const task = await createWorkItem(fx, { kind: 'task', title: 'Filed task' });
    await file(fx, task.id, bugs);
    expect(await root()).toMatchObject({ total: 1, workItemTotal: 0 });
    expect(await workItemsService.listFolderLevel(bugs, { sort: sort() }, fx.ctx)).toMatchObject({
      total: 1,
      workItemTotal: 1,
    });

    await createWorkItem(fx, { kind: 'story', title: 'Root story' });
    expect(await root()).toMatchObject({ total: 2, workItemTotal: 1 });
  });
});

describe('paging across the boundary', () => {
  it('walks two epics, three folders and four work items with take 3, straddling both boundaries, each row exactly once', async () => {
    const fx = await makeFixture();
    // Every project is born with a Bugs folder (MOTIR-4935), so it is part of this read.
    const bugs = await seededBugsFolderId(fx.projectId);
    const folders = [await folder(fx, 'A'), await folder(fx, 'B')];
    const epics = [];
    const items = [];
    for (let i = 1; i <= 4; i += 1) {
      items.push(await createWorkItem(fx, { kind: 'task', title: `Task ${i}` }));
      if (i <= 2) epics.push(await createWorkItem(fx, { kind: 'epic', title: `Epic ${i}` }));
    }

    const pages: string[][] = [];
    const more: boolean[] = [];
    let offset = 0;
    for (;;) {
      const level = await workItemsService.listRootIssues(
        fx.projectId,
        { sort: sort(), take: 3, offset },
        fx.ctx,
      );
      expect(level.total).toBe(9);
      pages.push(level.rows.map((r) => r.id));
      more.push(level.hasMore);
      offset += level.rows.length;
      if (!level.hasMore) break;
    }

    // Page 1 ends in the folder band; page 2 crosses from the folders into the work items.
    expect(pages).toEqual([
      [epics[0]!.id, epics[1]!.id, bugs],
      [folders[0]!.id, folders[1]!.id, items[0]!.id],
      [items[1]!.id, items[2]!.id, items[3]!.id],
    ]);
    expect(more).toEqual([true, true, false]);
  });
});

describe('filed items leave the root', () => {
  it('in the /items read and the opted-in sprint arm, but not in the roadmap read', async () => {
    const fx = await makeFixture();
    const sprint = await adminDb.sprint.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, name: 'Sprint 1', sequence: 1 },
    });
    // Every project is born with a Bugs folder (MOTIR-4935), so it is part of this read.
    const bugs = await seededBugsFolderId(fx.projectId);
    const later = await folder(fx, 'Later');
    const filed = await createWorkItem(fx, { kind: 'task', title: 'Filed' });
    const unfiled = await createWorkItem(fx, { kind: 'task', title: 'Unfiled' });
    await adminDb.workItem.updateMany({
      where: { id: { in: [filed.id, unfiled.id] } },
      data: { sprintId: sprint.id },
    });
    await file(fx, filed.id, later.id);

    const root = await workItemsService.listRootIssues(fx.projectId, { sort: sort() }, fx.ctx);
    expect(root.rows.map((r) => r.id)).toEqual([bugs, later.id, unfiled.id]);
    expect(root.total).toBe(3);

    const [sprintRoot, sprintCount, roadmapRoot, roadmapCount] = await withWorkspaceServiceContext(
      fx.workspaceId,
      async (tx) => [
        await workItemRepository.findProjectTreeLevel(
          fx.projectId,
          fx.workspaceId,
          null,
          sort(),
          { take: 50, offset: 0 },
          sprint.id,
          tx,
          { kind: 'excludeFiled' },
        ),
        await workItemRepository.countProjectTreeLevel(
          fx.projectId,
          fx.workspaceId,
          null,
          sprint.id,
          tx,
          undefined,
          { kind: 'excludeFiled' },
        ),
        await workItemRepository.findProjectTreeLevel(
          fx.projectId,
          fx.workspaceId,
          null,
          sort(),
          { take: 50, offset: 0 },
          sprint.id,
          tx,
        ),
        await workItemRepository.countProjectTreeLevel(
          fx.projectId,
          fx.workspaceId,
          null,
          sprint.id,
          tx,
        ),
      ],
    );
    expect((sprintRoot as { id: string }[]).map((r) => r.id)).toEqual([unfiled.id]);
    expect(sprintCount).toBe(1);
    expect((roadmapRoot as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [filed.id, unfiled.id].sort(),
    );
    expect(roadmapCount).toBe(2);
  });
});

describe('exclusions', () => {
  it('leaves archived and triaged filed items out of the level and out of hasChildren', async () => {
    const fx = await makeFixture();
    const holder = await folder(fx, 'Holder');
    const archived = await createWorkItem(fx, { kind: 'task', title: 'Archived' });
    const triaged = await createWorkItem(fx, { kind: 'task', title: 'Triaged' });
    await file(fx, archived.id, holder.id);
    await file(fx, triaged.id, holder.id);
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await adminDb.workItem.update({ where: { id: triaged.id }, data: { triagedAt: new Date() } });

    const level = await workItemsService.listFolderLevel(holder.id, { sort: sort() }, fx.ctx);
    expect(level).toEqual({ rows: [], hasMore: false, total: 0, workItemTotal: 0 });

    const root = await workItemsService.listRootIssues(fx.projectId, { sort: sort() }, fx.ctx);
    expect(root.rows.find((r) => r.id === holder.id)?.hasChildren).toBe(false);
  });
});
