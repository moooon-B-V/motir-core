import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';

// The folders story's VITEST GATE (Story MOTIR-5308 · MOTIR-5317) on a REAL
// Postgres: the ASSEMBLED feature, not each card's own units. Only the session
// and the active-project resolution are stubbed, for the two Server Actions
// driven here (a test has no cookies).
//
// What the card asks this gate to prove, and where:
//   seams
//     service → tree read                    → 'seam · service → tree read'
//     quick-view action → service → level    → 'seam · the quick view files an item'
//     folder-row action → typed refusal      → 'seam · folder-row refusals'
//   guards a percentage cannot see
//     filing is invisible to workflow reads  → 'guard · filing is invisible'
//     the one-place invariant                → 'guard · one place'
//     TENANCY — already proven under the non-bypass `motir_app` role, cited not
//       copied: tests/folder-schema-rls.test.ts › 'hides and refuses writes to
//       another workspace’s folders' and 'narrows reads to the bound project when
//       app.project_id is set'
//     the NAME RACE — already proven with two concurrent `createFolder` calls:
//       tests/integration/folders/foldersService.test.ts › 'races'
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { backlogService } from '@/lib/services/backlogService';
import { projectsService } from '@/lib/services/projectsService';
import { reportsService } from '@/lib/services/reportsService';
import { DEFAULT_SORT, type IssueSort } from '@/lib/issues/issueListView';
import type { TreeLevelDto } from '@/lib/dto/workItems';
import { createFolderAction, moveFolderAction } from '@/app/(authed)/items/actions';
import { fileWorkItemAction } from '@/app/(authed)/items/[key]/edit/actions';
import type { WorkItemKind } from '@/generated/prisma/client';
import { makeWorkItemFixture as makeFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

beforeEach(async () => {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const sort = (): IssueSort => ({ ...DEFAULT_SORT });

function actAs(fx: WorkItemFixture) {
  session.current = { user: { id: fx.ctx.userId } };
  activeCtx.current = {
    projectId: fx.projectId,
    userId: fx.ctx.userId,
    workspaceId: fx.workspaceId,
  };
}

/**
 * Created through the product's own write, so each item starts in the
 * workflow's initial status — the raw `createTestWorkItem` row writes `open`,
 * which no board column maps, and would leave the board guard comparing two
 * empty boards.
 */
function createWorkItem(
  fx: WorkItemFixture,
  input: { kind: WorkItemKind; title: string; parentId?: string },
) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, ...input }, fx.ctx);
}

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

function file(fx: WorkItemFixture, workItemId: string, folderId: string | null) {
  return foldersService.fileWorkItem(workItemId, { folderId }, fx.ctx);
}

/** A level as `[kind, id, hasChildren]`, folders first by construction. */
const shape = (level: TreeLevelDto) =>
  level.rows.map((r) => [r.kind, r.id, r.hasChildren] as const);

const rootLevel = (fx: WorkItemFixture) =>
  workItemsService.listRootIssues(fx.projectId, { sort: sort() }, fx.ctx);
const folderLevel = (fx: WorkItemFixture, folderId: string) =>
  workItemsService.listFolderLevel(folderId, { sort: sort() }, fx.ctx);
const childLevel = (fx: WorkItemFixture, parentId: string) =>
  workItemsService.listChildIssues(parentId, { sort: sort() }, fx.ctx);

/** The folder rows of a level, then the SET of its work-item rows. */
function split(level: TreeLevelDto) {
  const folders = level.rows.filter((r) => r.kind === 'folder');
  const items = level.rows.filter((r) => r.kind !== 'folder');
  // Folders first: no folder row may sit after a work-item row.
  expect(level.rows.slice(0, folders.length).every((r) => r.kind === 'folder')).toBe(true);
  return {
    folders: folders.map((r) => [r.id, r.hasChildren]),
    items: items.map((r) => r.id).sort(),
  };
}

describe('seam · service → tree read', () => {
  it('each write of the folder service reads back through the tree level exactly as written', async () => {
    const fx = await makeFixture();
    // Every project is born with a Bugs folder (MOTIR-4935), so it is part of this read.
    const bugs = await seededBugsFolderId(fx.projectId);
    const task = await createWorkItem(fx, { kind: 'task', title: 'Loose task' });
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    await createWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });

    // create: Later ▸ 2025, both empty.
    const later = await folder(fx, 'Later');
    const y2025 = await folder(fx, '2025', later.id);
    expect(split(await rootLevel(fx))).toEqual({
      folders: [
        [bugs, false],
        [later.id, true],
      ],
      items: [epic.id, task.id].sort(),
    });
    expect(split(await folderLevel(fx, y2025.id))).toEqual({ folders: [], items: [] });

    // file: the task leaves the root and is the only row of 2025.
    await file(fx, task.id, y2025.id);
    expect(split(await rootLevel(fx))).toEqual({
      folders: [
        [bugs, false],
        [later.id, true],
      ],
      items: [epic.id],
    });
    expect(shape(await folderLevel(fx, later.id))).toEqual([['folder', y2025.id, true]]);
    expect(shape(await folderLevel(fx, y2025.id))).toEqual([['task', task.id, false]]);

    // move: 2025 to the root, after Later — which is left with nothing in it.
    await foldersService.moveFolder(
      { projectId: fx.projectId, folderId: y2025.id, targetParentFolderId: null },
      fx.ctx,
    );
    expect(split(await rootLevel(fx))).toEqual({
      folders: [
        [bugs, false],
        [later.id, false],
        [y2025.id, true],
      ],
      items: [epic.id],
    });

    // delete: 2025's task moves up to 2025's parent — the root.
    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: y2025.id }, fx.ctx);
    expect(split(await rootLevel(fx))).toEqual({
      folders: [
        [bugs, false],
        [later.id, false],
      ],
      items: [epic.id, task.id].sort(),
    });
  });
});

describe('seam · the quick view files an item', () => {
  it('filing a story that has an epic parent: it is in the folder, gone from the epic, and keeps its own children', async () => {
    const fx = await makeFixture();
    actAs(fx);
    // Every project is born with a Bugs folder (MOTIR-4935), so it is part of this read.
    const bugs = await seededBugsFolderId(fx.projectId);
    const later = await folder(fx, 'Later');
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Auth' });
    const sibling = await createWorkItem(fx, { kind: 'story', title: 'Stays', parentId: epic.id });
    const story = await createWorkItem(fx, { kind: 'story', title: 'Moves', parentId: epic.id });
    const sub = await createWorkItem(fx, { kind: 'subtask', title: 'Sub', parentId: story.id });

    await expect(
      fileWorkItemAction({ workItemId: story.id, folderId: later.id }),
    ).resolves.toMatchObject({ ok: true });

    expect(shape(await folderLevel(fx, later.id))).toEqual([['story', story.id, true]]);
    expect(shape(await childLevel(fx, epic.id))).toEqual([['story', sibling.id, false]]);
    expect(shape(await childLevel(fx, story.id))).toEqual([['subtask', sub.id, false]]);
    expect(split(await rootLevel(fx))).toEqual({
      folders: [
        [bugs, false],
        [later.id, true],
      ],
      items: [epic.id],
    });
  });
});

describe('seam · folder-row refusals', () => {
  it('each typed refusal reaches the action boundary as its mapped code, never a raw database error', async () => {
    const fx = await makeFixture();
    actAs(fx);
    // Every project is born with a Bugs folder (MOTIR-4935), so it is part of this read.
    const bugs = await seededBugsFolderId(fx.projectId);
    const later = await folder(fx, 'Later');
    const inner = await folder(fx, 'Inner', later.id);
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ctx.userId,
      name: 'Second project',
      identifier: 'SECND',
    });
    const elsewhere = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      fx.ctx,
    );

    await expect(createFolderAction({ parentFolderId: null, name: 'later' })).resolves.toEqual({
      ok: false,
      code: 'FOLDER_NAME_TAKEN',
      error: expect.any(String),
      folderName: 'later',
    });
    await expect(
      moveFolderAction({ folderId: later.id, targetParentFolderId: inner.id }),
    ).resolves.toEqual({
      ok: false,
      code: 'FOLDER_CYCLE',
      error: 'A folder can’t move into one of its own folders.',
    });
    await expect(
      moveFolderAction({ folderId: inner.id, targetParentFolderId: elsewhere.id }),
    ).resolves.toEqual({
      ok: false,
      code: 'CROSS_PROJECT_FOLDER',
      error: 'That folder belongs to another project.',
    });

    // And none of the three wrote anything.
    expect(split(await rootLevel(fx))).toEqual({
      folders: [
        [bugs, false],
        [later.id, true],
      ],
      items: [],
    });
    expect(shape(await folderLevel(fx, later.id))).toEqual([['folder', inner.id, false]]);
  });
});

describe('guard · filing is invisible to workflow reads', () => {
  /** Every workflow read the story promises not to move, reduced to what it shows. */
  async function workflowReads(fx: WorkItemFixture) {
    const board = await boardsService.getBoard(fx.projectId, fx.ctx);
    const backlog = await backlogService.getBacklog(fx.projectId, { limit: 100 }, fx.ctx);
    const ready = await workItemsService.listReady(fx.projectId, { limit: 100 }, fx.ctx);
    const readyCount = await workItemsService.countReady(fx.projectId, {}, fx.ctx);
    const scope = { projectId: fx.projectId };
    const cvr = await reportsService.getCreatedVsResolved(
      scope,
      { period: 'day', daysBack: 7, cumulative: false },
      fx.ctx,
    );
    const distribution = await reportsService.getDistribution(scope, 'status', fx.ctx);
    if (cvr.state !== 'ok' || distribution.state !== 'ok') throw new Error('report not ok');
    return {
      board: board.columns.map((c) => ({
        id: c.id,
        totalCount: c.totalCount,
        cards: c.cards.map((card) => card.id).sort(),
      })),
      backlog: { total: backlog.totalCount, ids: backlog.items.map((i) => i.id) },
      ready: ready.items.map((i) => i.id).sort(),
      readyCount,
      // The window's own instants are the read time; the buckets are the data.
      createdVsResolved: cvr.data.buckets,
      distribution: { total: distribution.data.total, segments: distribution.data.segments },
    };
  }

  it('board, backlog, ready list and both reports read the same before filing, after filing into nested folders, and after deleting them', async () => {
    const fx = await makeFixture();
    const auth = await createWorkItem(fx, { kind: 'epic', title: 'Auth' });
    const signIn = await createWorkItem(fx, { kind: 'story', title: 'Sign in', parentId: auth.id });
    await createWorkItem(fx, { kind: 'subtask', title: 'Form', parentId: signIn.id });
    await createWorkItem(fx, { kind: 'story', title: 'Sign out', parentId: auth.id });
    const billing = await createWorkItem(fx, { kind: 'epic', title: 'Billing' });
    await createWorkItem(fx, { kind: 'story', title: 'Invoices', parentId: billing.id });
    const tidy = await createWorkItem(fx, { kind: 'task', title: 'Tidy' });
    const flaky = await createWorkItem(fx, { kind: 'bug', title: 'Flaky' });
    const docs = await createWorkItem(fx, { kind: 'task', title: 'Docs' });
    const release = await createWorkItem(fx, { kind: 'task', title: 'Release' });
    // Spread across the workflow so the board, the ready list and both reports
    // each have more than one bucket to keep identical.
    await workItemsService.updateStatus(tidy.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(release.id, 'in_progress', fx.ctx);
    await workItemsService.updateStatus(release.id, 'done', fx.ctx);

    const before = await workflowReads(fx);
    // The fixture is not vacuous: every read has something in it to lose.
    expect(before.board.flatMap((c) => c.cards).length).toBeGreaterThan(0);
    expect(before.backlog.ids.length).toBeGreaterThan(0);
    expect(before.ready.length).toBeGreaterThan(0);
    expect(before.distribution.total).toBeGreaterThan(0);

    // File four of the project's six ROOT items — one epic carrying its
    // subtree, one in progress — into folders three deep. Filing keeps
    // `parentId` null, which is the whole reason no workflow read can see it.
    const later = await folder(fx, 'Later');
    const y2025 = await folder(fx, '2025', later.id);
    const q1 = await folder(fx, 'Q1', y2025.id);
    const research = await folder(fx, 'Research');
    await file(fx, billing.id, q1.id);
    await file(fx, tidy.id, y2025.id);
    await file(fx, flaky.id, research.id);
    await file(fx, docs.id, later.id);
    // Only Auth and the done Release are left at the /items root.
    expect(
      (await rootLevel(fx)).rows
        .filter((r) => r.kind !== 'folder')
        .map((r) => r.id)
        .sort(),
    ).toEqual([auth.id, release.id].sort());

    expect(await workflowReads(fx)).toEqual(before);

    // Delete every folder, innermost first: each one's contents move up.
    for (const f of [q1, y2025, later, research]) {
      await foldersService.deleteFolder({ projectId: fx.projectId, folderId: f.id }, fx.ctx);
    }
    // Only the seeded Bugs folder (MOTIR-4935) is left, and it was never touched.
    expect((await rootLevel(fx)).rows.filter((r) => r.kind === 'folder').map((r) => r.id)).toEqual([
      await seededBugsFolderId(fx.projectId),
    ]);

    expect(await workflowReads(fx)).toEqual(before);
  });
});

describe('guard · one place', () => {
  it('no sequence of file, re-parent, move folder and delete folder leaves an item with both a parent and a folder', async () => {
    const fx = await makeFixture();
    const epic = await createWorkItem(fx, { kind: 'epic', title: 'Epic' });
    const story = await createWorkItem(fx, { kind: 'story', title: 'Story', parentId: epic.id });
    await createWorkItem(fx, { kind: 'subtask', title: 'Sub', parentId: story.id });
    const task = await createWorkItem(fx, { kind: 'task', title: 'Task' });

    const inTwoPlaces = async () =>
      adminDb.workItem.count({
        where: { projectId: fx.projectId, parentId: { not: null }, folderId: { not: null } },
      });
    const placeOf = (id: string) =>
      adminDb.workItem.findUniqueOrThrow({
        where: { id },
        select: { parentId: true, folderId: true },
      });

    const outer = await folder(fx, 'Outer');
    const inner = await folder(fx, 'Inner', outer.id);
    const steps: Array<[string, () => Promise<unknown>]> = [
      ['file the story into Inner', () => file(fx, story.id, inner.id)],
      [
        're-parent it under the epic',
        () => workItemsService.moveWorkItem(story.id, { newParentId: epic.id }, fx.ctx),
      ],
      ['file the task into Outer', () => file(fx, task.id, outer.id)],
      ['file the story into Inner again', () => file(fx, story.id, inner.id)],
      [
        'move Inner to the root',
        () =>
          foldersService.moveFolder(
            { projectId: fx.projectId, folderId: inner.id, targetParentFolderId: null },
            fx.ctx,
          ),
      ],
      [
        'move Outer into Inner',
        () =>
          foldersService.moveFolder(
            { projectId: fx.projectId, folderId: outer.id, targetParentFolderId: inner.id },
            fx.ctx,
          ),
      ],
      [
        'delete Inner',
        () => foldersService.deleteFolder({ projectId: fx.projectId, folderId: inner.id }, fx.ctx),
      ],
      [
        're-parent the task under the story',
        () => workItemsService.moveWorkItem(task.id, { newParentId: story.id }, fx.ctx),
      ],
      [
        'delete Outer',
        () => foldersService.deleteFolder({ projectId: fx.projectId, folderId: outer.id }, fx.ctx),
      ],
    ];

    for (const [label, step] of steps) {
      await step();
      expect({ label, inTwoPlaces: await inTwoPlaces() }).toEqual({ label, inTwoPlaces: 0 });
    }

    // And each ended where the last write put it.
    await expect(placeOf(story.id)).resolves.toEqual({ parentId: null, folderId: null });
    await expect(placeOf(task.id)).resolves.toEqual({ parentId: story.id, folderId: null });
  });
});
