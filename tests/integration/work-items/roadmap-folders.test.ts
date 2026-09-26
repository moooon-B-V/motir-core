import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { PlacementConflictError } from '@/lib/folders/errors';
import type { WorkItemKindDto } from '@/lib/dto/workItems';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { seedBlockedBy } from '../../helpers/seedBlockedBy';

// FOLDERS ON THE ROADMAP — the read (Bug MOTIR-5710 · MOTIR-5738,
// `design/roadmap/design-notes.md` § *A FOLDER on the canvas*, decisions 1, 3, 4,
// 6 and 8). The folder treatment is OPT-IN: without it the read is what it always
// was; with it the project-scope root leaves filed rows out and returns the root
// folders, a folder is its own level, each folder carries its DIRECT counts from
// one aggregate, and the work-item cap never counts or cuts a folder.
//
// Real Postgres, no mocks (CLAUDE.md). The one spy counts repository CALLS to pin
// that the folder counts are one read per level, not one per folder.

let fx: WorkItemFixture;

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function make(kind: WorkItemKindDto, title: string, parentId: string | null = null) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, parentId },
    fx.ctx,
  );
}

function folder(name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

function file(workItemId: string, folderId: string | null) {
  return foldersService.fileWorkItem(workItemId, { folderId }, fx.ctx);
}

const read = (
  parentId: string | null,
  opts: Parameters<typeof workItemsService.getProjectRoadmap>[3] = {},
) => workItemsService.getProjectRoadmap(fx.projectId, parentId, fx.ctx, opts);

/**
 * Root: epics E1 + E2, an unfiled bug, and folder A (holding child folder A1,
 * a filed epic, a filed bug, and a filed task) plus an empty root folder Z. A1
 * holds one filed bug.
 */
async function tree() {
  const e1 = await make('epic', 'Road epic one');
  const e2 = await make('epic', 'Road epic two');
  const loose = await make('bug', 'Unfiled bug');
  const a = await folder('A');
  const z = await folder('Z');
  const a1 = await folder('A1', a.id);
  const filedEpic = await make('epic', 'Filed epic');
  await make('story', 'Story under the filed epic', filedEpic.id);
  const filedBug = await make('bug', 'Filed bug');
  const filedTask = await make('task', 'Filed task');
  const deepBug = await make('bug', 'Deep bug');
  await file(filedEpic.id, a.id);
  await file(filedBug.id, a.id);
  await file(filedTask.id, a.id);
  await file(deepBug.id, a1.id);
  return { e1, e2, loose, a, z, a1, filedEpic, filedBug, filedTask, deepBug };
}

describe('without the folder option — every other canvas sees nothing move', () => {
  it('the root, a parent level, sprint scope and an id set read exactly as if nothing were filed', async () => {
    const t = await tree();
    const sprint = await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'S1',
        state: 'active',
        sequence: 1,
      },
    });
    await adminDb.workItem.update({ where: { id: t.filedBug.id }, data: { sprintId: sprint.id } });

    const root = await read(null);
    expect(root.nodes.map((n) => n.id).sort()).toEqual(
      [
        t.e1.id,
        t.e2.id,
        t.loose.id,
        t.filedEpic.id,
        t.filedBug.id,
        t.filedTask.id,
        t.deepBug.id,
      ].sort(),
    );
    expect(root.levelTotal).toBe(7);
    expect(root).not.toHaveProperty('folders');

    const children = await read(t.filedEpic.id);
    expect(children.nodes).toHaveLength(1);
    expect(children).not.toHaveProperty('folders');

    const sprintRoot = await read(null, { scope: 'sprint' });
    expect(sprintRoot.nodes.map((n) => n.id)).toEqual([t.filedBug.id]);

    const byIds = await read(null, { ids: [t.filedBug.id, t.e1.id] });
    expect(byIds.nodes.map((n) => n.id).sort()).toEqual([t.filedBug.id, t.e1.id].sort());
    expect(byIds).not.toHaveProperty('folders');
  });
});

describe('with the folder option — the project-scope ROOT', () => {
  it('leaves every filed work item out, whatever its kind, and returns the root folders in position order', async () => {
    const t = await tree();

    const root = await read(null, { folders: true });

    expect(root.nodes.map((n) => n.id).sort()).toEqual([t.e1.id, t.e2.id, t.loose.id].sort());
    // A new project carries its seeded Bugs folder too; ours keep their order.
    const ours = new Set([t.a.id, t.z.id]);
    expect(root.folders?.map((f) => f.id).filter((id) => ours.has(id))).toEqual([t.a.id, t.z.id]);
    // The M of "Showing N of M" counts WORK ITEMS only (decision 4).
    expect(root.levelTotal).toBe(3);
  });

  it('carries each folder’s DIRECT counts — child folders and filed items, not recursive', async () => {
    const t = await tree();

    const root = await read(null, { folders: true });
    const byId = new Map(root.folders?.map((f) => [f.id, f]));

    // A holds A1 + three filed items; the story under the filed epic and A1's bug
    // are NOT counted — a filed epic counts once, however much it holds.
    expect(byId.get(t.a.id)).toMatchObject({ name: 'A', childFolderCount: 1, itemCount: 3 });
    expect(byId.get(t.z.id)).toMatchObject({ name: 'Z', childFolderCount: 0, itemCount: 0 });
  });

  it('does not count an archived or a triaged item filed in a folder', async () => {
    const t = await tree();
    await workItemsService.archiveWorkItem(t.filedTask.id, fx.ctx);
    await adminDb.workItem.update({
      where: { id: t.filedBug.id },
      data: { triagedAt: new Date() },
    });

    const root = await read(null, { folders: true });
    expect(root.folders?.find((f) => f.id === t.a.id)?.itemCount).toBe(1);
  });

  it('reads the counts for a whole level in ONE call, however many folders it holds', async () => {
    const seeded = (await read(null, { folders: true })).folders?.length ?? 0;
    await tree();
    for (let i = 0; i < 6; i += 1) await folder(`Extra ${i}`);
    const counts = vi.spyOn(folderRepository, 'countDirectContents');
    const level = vi.spyOn(folderRepository, 'findLevel');

    const root = await read(null, { folders: true });

    expect(root.folders).toHaveLength(seeded + 8);
    expect(counts).toHaveBeenCalledTimes(1);
    expect(level).toHaveBeenCalledTimes(1);
  });
});

describe('with the folder option — a FOLDER level', () => {
  it('returns its child folders and the work items filed directly in it', async () => {
    const t = await tree();

    const inside = await read(null, { folders: true, folderId: t.a.id });

    expect(inside.folders?.map((f) => [f.id, f.itemCount])).toEqual([[t.a1.id, 1]]);
    expect(inside.nodes.map((n) => n.id).sort()).toEqual(
      [t.filedEpic.id, t.filedBug.id, t.filedTask.id].sort(),
    );
    expect(inside.levelTotal).toBe(3);

    const deeper = await read(null, { folders: true, folderId: t.a1.id });
    expect(deeper.folders).toEqual([]);
    expect(deeper.nodes.map((n) => n.id)).toEqual([t.deepBug.id]);
  });

  it('an empty folder is an empty level, still answered with its (empty) folder list', async () => {
    const t = await tree();

    const empty = await read(null, { folders: true, folderId: t.z.id });

    expect(empty.nodes).toEqual([]);
    expect(empty.folders).toEqual([]);
    expect(empty.levelTotal).toBe(0);
  });

  it('a folder of ANOTHER project reads as an empty level — never its contents', async () => {
    await tree();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const theirs = await foldersService.createFolder(
      { projectId: other.projectId, parentFolderId: null, name: 'Theirs' },
      other.ctx,
    );
    const secret = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'bug', title: 'Secret' },
      other.ctx,
    );
    await foldersService.fileWorkItem(secret.id, { folderId: theirs.id }, other.ctx);

    const level = await read(null, { folders: true, folderId: theirs.id });

    expect(level.nodes).toEqual([]);
    expect(level.folders).toEqual([]);
  });

  it('refuses a level addressed by a parent AND a folder at once', async () => {
    const t = await tree();

    await expect(read(t.e1.id, { folders: true, folderId: t.a.id })).rejects.toBeInstanceOf(
      PlacementConflictError,
    );
  });
});

describe('with the folder option — where it does NOT apply', () => {
  it('sprint scope draws no folder and ignores placement (decision 6)', async () => {
    const t = await tree();
    const sprint = await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'S1',
        state: 'active',
        sequence: 1,
      },
    });
    await adminDb.workItem.update({ where: { id: t.filedBug.id }, data: { sprintId: sprint.id } });

    const root = await read(null, { folders: true, scope: 'sprint' });
    expect(root.nodes.map((n) => n.id)).toEqual([t.filedBug.id]);
    expect(root).not.toHaveProperty('folders');

    const folderInSprint = await read(null, { folders: true, scope: 'sprint', folderId: t.a.id });
    expect(folderInSprint.nodes).toEqual([]);
  });

  it('an explicit id set draws no folder and excludes nothing (decision 8)', async () => {
    const t = await tree();

    const level = await read(null, { folders: true, ids: [t.filedBug.id, t.e1.id] });

    expect(level.nodes.map((n) => n.id).sort()).toEqual([t.filedBug.id, t.e1.id].sort());
    expect(level).not.toHaveProperty('folders');
  });

  it('a work item’s children level carries no folders', async () => {
    const t = await tree();

    const children = await read(t.filedEpic.id, { folders: true });

    expect(children.nodes).toHaveLength(1);
    expect(children).not.toHaveProperty('folders');
  });
});

describe('with the folder option — a FILED blocker is off the root level', () => {
  it('a root row blocked by a filed item anchors it as OFF-level, not as a cap-dropped sibling', async () => {
    const t = await tree();
    await workItemsService.linkWorkItems(
      { fromId: t.loose.id, toId: t.filedBug.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const root = await read(null, { folders: true });

    expect(root.offLevelBlockers.map((b) => b.id)).toEqual([t.filedBug.id]);
    expect(root.levelMemberBlockers).toEqual([]);
  });

  it('inside a folder, a blocker filed in ANOTHER folder is off-level too', async () => {
    const t = await tree();
    await workItemsService.linkWorkItems(
      { fromId: t.filedTask.id, toId: t.deepBug.id, kind: 'is_blocked_by' },
      fx.ctx,
    );

    const inside = await read(null, { folders: true, folderId: t.a.id });

    expect(inside.offLevelBlockers.map((b) => b.id)).toEqual([t.deepBug.id]);
    expect(inside.levelMemberBlockers).toEqual([]);
  });
});

describe('an OFF-level blocker names its folder (MOTIR-5739)', () => {
  it('a filed blocker carries its folder path, root first; an unfiled one carries null', async () => {
    const t = await tree();
    // Seeded below the doors: this block is about how the roadmap RENDERS an
    // off-level blocker, and some of these edges join two depths — which the
    // link door refuses (MOTIR-6369 / 6411) while the tree still carries them.
    await seedBlockedBy(fx, t.e1.id, t.deepBug.id);
    const road = await make('story', 'Road story', t.e2.id);
    await seedBlockedBy(fx, t.e1.id, road.id);

    // Project-wide root, no folder option — the path is a fact about the blocker.
    const root = await read(null);
    const byId = new Map(root.offLevelBlockers.map((b) => [b.id, b]));
    // deepBug is ON the plain root (it is parentless), so it is not off-level here.
    expect(byId.has(t.deepBug.id)).toBe(false);
    expect(byId.get(road.id)?.folderPath).toBeNull();

    const foldered = await read(null, { folders: true });
    const offById = new Map(foldered.offLevelBlockers.map((b) => [b.id, b]));
    expect(offById.get(t.deepBug.id)?.folderPath).toEqual(['A', 'A1']);
  });

  it('a child of a filed epic carries the epic’s folder path', async () => {
    const t = await tree();
    const underFiled = await make('story', 'Under the filed epic', t.filedEpic.id);
    // Seeded below the doors: this block is about how the roadmap RENDERS an
    // off-level blocker, and some of these edges join two depths — which the
    // link door refuses (MOTIR-6369 / 6411) while the tree still carries them.
    await seedBlockedBy(fx, t.e1.id, underFiled.id);

    const root = await read(null, { folders: true });

    expect(root.offLevelBlockers.find((b) => b.id === underFiled.id)?.folderPath).toEqual(['A']);
  });

  it('resolves every stub’s folder in a bounded number of reads, whatever the stub count', async () => {
    const t = await tree();
    // Seeded below the doors: this block is about how the roadmap RENDERS an
    // off-level blocker, and some of these edges join two depths — which the
    // link door refuses (MOTIR-6369 / 6411) while the tree still carries them.
    for (const id of [t.filedBug.id, t.filedTask.id, t.deepBug.id]) {
      await seedBlockedBy(fx, t.e1.id, id);
    }
    const paths = vi.spyOn(folderRepository, 'findPathsByIds');

    const root = await read(null, { folders: true });

    expect(root.offLevelBlockers).toHaveLength(3);
    expect(paths).toHaveBeenCalledTimes(1);
  });
});
