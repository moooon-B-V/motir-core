import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { createPage, movePage, pageStoreFor, systemClock, type PagePlacement } from '@/lib/pages';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  CrossProjectFolderError,
  FOLDER_NAME_MAX_LENGTH,
  FolderCycleError,
  FolderNameTakenError,
  FolderNotFoundError,
  InvalidFolderNameError,
  SubtaskNeedsPlacementError,
} from '@/lib/folders/errors';
import { IllegalParentTypeError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { setWorkspaceRoleFor } from '../../helpers/workspaceRoleFixtures';

// The FOLDER SERVICE (Story MOTIR-5308 · MOTIR-5313) on a REAL Postgres, through
// the service with the ordinary workspace context — so every read and write runs
// under the `folder` / `work_item` policies exactly as a request would.
//
// What the card asks this file to prove, and where:
//   1  each operation's success path and every refusal, as TYPED errors — and a
//      race on a sibling name surfacing as `FolderNameTakenError`, not P2002
//      → 'createFolder' / 'renameFolder' / 'moveFolder' / 'races'
//   2  delete moves two child folders and three filed items (one an epic with
//      two stories) up, and changes nothing else  → 'deleteFolder'
//   3  filing clears `parentId`; `moveWorkItem` onto an epic clears `folderId`
//      → 'fileWorkItem' / 'moveWorkItem'
//   4  two concurrent moves that would form a cycle: exactly one lands
//      → 'races'
//   5  a member without `work_item:edit` is refused on every method BEFORE any
//      folder read — proven with folder ids that do not exist  → 'the gate'
//   6  a folder holds PAGES too (Story MOTIR-5753 · MOTIR-7371): delete moves its
//      pages up after the destination's pages, in order, sub-pages untouched;
//      a delete racing a page move into the folder terminates either way with no
//      FK failure; the `/pages` level read counts pages, `/items`' does not
//      → 'deleteFolder — pages' / 'folder level and counts — pages'

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item", "folder" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function item(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
  title: string,
  parentId?: string,
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return dto.id;
}

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

async function row(id: string) {
  return adminDb.workItem.findUniqueOrThrow({
    where: { id },
    select: { id: true, parentId: true, folderId: true },
  });
}

async function secondProject(fx: WorkItemFixture) {
  return projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ctx.userId,
    name: 'Second project',
    identifier: 'SECND',
  });
}

describe('createFolder', () => {
  it('creates at the root and inside a folder, appending in order, trimming the name', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, '  Later  ');
    const archive = await folder(fx, 'Archive');
    const nested = await folder(fx, '2025', later.id);

    expect(later).toMatchObject({
      name: 'Later',
      parentFolderId: null,
      createdById: fx.ctx.userId,
    });
    expect(archive.position > later.position).toBe(true);
    expect(nested).toMatchObject({ name: '2025', parentFolderId: later.id });
  });

  it('refuses an empty or over-long name, and a case-insensitive sibling collision', async () => {
    const fx = await makeWorkItemFixture();
    await expect(folder(fx, '   ')).rejects.toMatchObject({
      code: 'INVALID_FOLDER_NAME',
      reason: 'empty',
    });
    await expect(folder(fx, 'x'.repeat(FOLDER_NAME_MAX_LENGTH + 1))).rejects.toBeInstanceOf(
      InvalidFolderNameError,
    );

    const later = await folder(fx, 'Later');
    await expect(folder(fx, 'later')).rejects.toBeInstanceOf(FolderNameTakenError);
    await folder(fx, 'Inside', later.id);
    await expect(folder(fx, 'INSIDE', later.id)).rejects.toBeInstanceOf(FolderNameTakenError);
  });

  it('refuses a parent that does not exist or lives in another project', async () => {
    const fx = await makeWorkItemFixture();
    const other = await secondProject(fx);
    const foreign = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      fx.ctx,
    );

    await expect(folder(fx, 'A', 'no-such-folder')).rejects.toBeInstanceOf(FolderNotFoundError);
    await expect(folder(fx, 'A', foreign.id)).rejects.toBeInstanceOf(CrossProjectFolderError);
  });
});

describe('renameFolder', () => {
  it('renames, accepts a change of case alone, and refuses a sibling name', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    await folder(fx, 'Parked');

    const recased = await foldersService.renameFolder(
      { projectId: fx.projectId, folderId: later.id, name: 'LATER' },
      fx.ctx,
    );
    expect(recased.name).toBe('LATER');
    const same = await foldersService.renameFolder(
      { projectId: fx.projectId, folderId: later.id, name: 'LATER' },
      fx.ctx,
    );
    expect(same.updatedAt).toBe(recased.updatedAt);

    await expect(
      foldersService.renameFolder(
        { projectId: fx.projectId, folderId: later.id, name: 'parked' },
        fx.ctx,
      ),
    ).rejects.toMatchObject({ code: 'FOLDER_NAME_TAKEN', folderName: 'parked' });
  });

  it('treats a folder addressed through the wrong project as not found', async () => {
    const fx = await makeWorkItemFixture();
    const other = await secondProject(fx);
    const later = await folder(fx, 'Later');
    await expect(
      foldersService.renameFolder({ projectId: other.id, folderId: later.id, name: 'X' }, fx.ctx),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
  });
});

describe('moveFolder', () => {
  it('moves into a folder and back to the root, and reorders among siblings', async () => {
    const fx = await makeWorkItemFixture();
    const a = await folder(fx, 'A');
    const b = await folder(fx, 'B');
    const c = await folder(fx, 'C');

    const intoA = await foldersService.moveFolder(
      { projectId: fx.projectId, folderId: c.id, targetParentFolderId: a.id },
      fx.ctx,
    );
    expect(intoA.parentFolderId).toBe(a.id);

    const back = await foldersService.moveFolder(
      { projectId: fx.projectId, folderId: c.id, targetParentFolderId: null },
      fx.ctx,
    );
    expect(back.parentFolderId).toBeNull();

    // Reorder: C to sit between A and B.
    const reordered = await foldersService.moveFolder(
      {
        projectId: fx.projectId,
        folderId: c.id,
        targetParentFolderId: null,
        beforeId: a.id,
        afterId: b.id,
      },
      fx.ctx,
    );
    expect(reordered.position > a.position && reordered.position < b.position).toBe(true);

    // A move to where it already is changes nothing.
    const noop = await foldersService.moveFolder(
      { projectId: fx.projectId, folderId: c.id, targetParentFolderId: null },
      fx.ctx,
    );
    expect(noop.updatedAt).toBe(reordered.updatedAt);
  });

  it('refuses itself, a descendant, another project, a missing target, and a name clash', async () => {
    const fx = await makeWorkItemFixture();
    const other = await secondProject(fx);
    const outer = await folder(fx, 'Outer');
    const inner = await folder(fx, 'Inner', outer.id);
    await folder(fx, 'Inner');
    const foreign = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      fx.ctx,
    );
    const move = (folderId: string, targetParentFolderId: string | null) =>
      foldersService.moveFolder(
        { projectId: fx.projectId, folderId, targetParentFolderId },
        fx.ctx,
      );

    await expect(move(outer.id, outer.id)).rejects.toBeInstanceOf(FolderCycleError);
    await expect(move(outer.id, inner.id)).rejects.toBeInstanceOf(FolderCycleError);
    await expect(move(outer.id, foreign.id)).rejects.toBeInstanceOf(CrossProjectFolderError);
    await expect(move(outer.id, 'no-such-folder')).rejects.toBeInstanceOf(FolderNotFoundError);
    await expect(move(inner.id, null)).rejects.toMatchObject({
      code: 'FOLDER_NAME_TAKEN',
      folderName: 'Inner',
    });
    await expect(
      foldersService.moveFolder(
        {
          projectId: fx.projectId,
          folderId: inner.id,
          targetParentFolderId: outer.id,
          beforeId: 'gone',
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
  });
});

describe('deleteFolder', () => {
  it('moves two child folders and three filed items up, keeps the subtree, and changes nothing else', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await folder(fx, 'Parent');
    const doomed = await folder(fx, 'Doomed', parent.id);
    const childOne = await folder(fx, 'One', doomed.id);
    const childTwo = await folder(fx, 'Two', doomed.id);
    const bystanderFolder = await folder(fx, 'Bystander');

    const epic = await item(fx, 'epic', 'Epic');
    const storyA = await item(fx, 'story', 'Story A', epic);
    const storyB = await item(fx, 'story', 'Story B', epic);
    const task = await item(fx, 'task', 'Task');
    const bug = await item(fx, 'bug', 'Bug');
    const bystander = await item(fx, 'task', 'Bystander');
    for (const id of [epic, task, bug]) {
      await foldersService.fileWorkItem(id, { folderId: doomed.id }, fx.ctx);
    }
    await foldersService.fileWorkItem(bystander, { folderId: bystanderFolder.id }, fx.ctx);

    const before = await adminDb.workItem.findMany({ orderBy: { id: 'asc' } });
    const foldersBefore = await adminDb.folder.findMany({ orderBy: { id: 'asc' } });

    const result = await foldersService.deleteFolder(
      { projectId: fx.projectId, folderId: doomed.id },
      fx.ctx,
    );
    expect(result).toEqual({
      deletedFolderId: doomed.id,
      destinationFolderId: parent.id,
      movedFolderIds: [childOne.id, childTwo.id],
      movedWorkItemIds: expect.arrayContaining([epic, task, bug]),
      movedPageIds: [],
    });

    const foldersAfter = await adminDb.folder.findMany({ orderBy: { id: 'asc' } });
    expect(foldersAfter.map((f) => f.id)).toEqual(
      foldersBefore.filter((f) => f.id !== doomed.id).map((f) => f.id),
    );
    for (const f of foldersAfter) {
      const was = foldersBefore.find((b) => b.id === f.id)!;
      if (f.id === childOne.id || f.id === childTwo.id) {
        expect(f.parentFolderId).toBe(parent.id);
      } else {
        expect(f).toEqual(was);
      }
    }

    const after = await adminDb.workItem.findMany({ orderBy: { id: 'asc' } });
    expect(after.map((w) => w.id)).toEqual(before.map((w) => w.id));
    for (const w of after) {
      const was = before.find((b) => b.id === w.id)!;
      if ([epic, task, bug].includes(w.id)) {
        expect(w).toMatchObject({ folderId: parent.id, parentId: null });
      } else {
        expect({ folderId: w.folderId, parentId: w.parentId, position: w.position }).toEqual({
          folderId: was.folderId,
          parentId: was.parentId,
          position: was.position,
        });
      }
    }
    expect((await row(storyA)).parentId).toBe(epic);
    expect((await row(storyB)).parentId).toBe(epic);
  });

  it('deletes a root folder into the root, including a child that shares its name', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const same = await folder(fx, 'later', later.id);
    const task = await item(fx, 'task', 'Task');
    await foldersService.fileWorkItem(task, { folderId: later.id }, fx.ctx);

    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: later.id }, fx.ctx);
    expect(await adminDb.folder.findUniqueOrThrow({ where: { id: same.id } })).toMatchObject({
      name: 'later',
      parentFolderId: null,
    });
    expect(await row(task)).toMatchObject({ folderId: null, parentId: null });
  });

  it('refuses, changing nothing, when a child name clashes or a filed subtask would be left unplaced', async () => {
    const fx = await makeWorkItemFixture();
    const doomed = await folder(fx, 'Doomed');
    await folder(fx, 'Clash', doomed.id);
    await folder(fx, 'clash');
    await expect(
      foldersService.deleteFolder({ projectId: fx.projectId, folderId: doomed.id }, fx.ctx),
    ).rejects.toMatchObject({ code: 'FOLDER_NAME_TAKEN', folderName: 'Clash' });

    const holder = await folder(fx, 'Holder');
    const story = await item(fx, 'story', 'Story');
    const subtask = await item(fx, 'subtask', 'Subtask', story);
    await foldersService.fileWorkItem(subtask, { folderId: holder.id }, fx.ctx);
    await expect(
      foldersService.deleteFolder({ projectId: fx.projectId, folderId: holder.id }, fx.ctx),
    ).rejects.toBeInstanceOf(SubtaskNeedsPlacementError);
    expect(await adminDb.folder.count({ where: { id: { in: [doomed.id, holder.id] } } })).toBe(2);
    expect(await row(subtask)).toMatchObject({ folderId: holder.id });
  });
});

describe('fileWorkItem', () => {
  it('files an item with a parent (clearing it), records the move, and takes it back out', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const epic = await item(fx, 'epic', 'Epic');
    const story = await item(fx, 'story', 'Story', epic);

    const filed = await foldersService.fileWorkItem(story, { folderId: later.id }, fx.ctx);
    expect(filed).toMatchObject({ workItemId: story, folderId: later.id, parentId: null });

    const revisions = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      workItemRevisionRepository.listByWorkItem(story, {}, tx),
    );
    expect(revisions[0]!.diff).toMatchObject({
      folderId: { from: null, to: later.id },
      parentId: { from: epic, to: null },
    });

    // Filing again into the same folder is a no-op.
    expect(await foldersService.fileWorkItem(story, { folderId: later.id }, fx.ctx)).toEqual(filed);

    const out = await foldersService.fileWorkItem(story, { folderId: null }, fx.ctx);
    expect(out).toMatchObject({ folderId: null, parentId: null });
    expect(await foldersService.fileWorkItem(story, { folderId: null }, fx.ctx)).toEqual(out);
  });

  it('files a subtask, and refuses taking it out with no parent to return to', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const story = await item(fx, 'story', 'Story');
    const subtask = await item(fx, 'subtask', 'Subtask', story);

    await foldersService.fileWorkItem(subtask, { folderId: later.id }, fx.ctx);
    expect(await row(subtask)).toMatchObject({ folderId: later.id, parentId: null });
    await expect(
      foldersService.fileWorkItem(subtask, { folderId: null }, fx.ctx),
    ).rejects.toBeInstanceOf(IllegalParentTypeError);
  });

  it('refuses a missing folder and a folder in another project', async () => {
    const fx = await makeWorkItemFixture();
    const other = await secondProject(fx);
    const foreign = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      fx.ctx,
    );
    const task = await item(fx, 'task', 'Task');

    await expect(
      foldersService.fileWorkItem(task, { folderId: 'no-such-folder' }, fx.ctx),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
    await expect(
      foldersService.fileWorkItem(task, { folderId: foreign.id }, fx.ctx),
    ).rejects.toBeInstanceOf(CrossProjectFolderError);
  });

  it('translates the database refusal of a cross-project folder at the repository edge', async () => {
    const fx = await makeWorkItemFixture();
    const other = await secondProject(fx);
    const foreign = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      fx.ctx,
    );
    const task = await item(fx, 'task', 'Task');
    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        workItemRepository.update(task, { folderId: foreign.id }, tx),
      ),
    ).rejects.toBeInstanceOf(CrossProjectFolderError);
  });
});

describe('moveWorkItem', () => {
  it('clears folderId when a filed item is given a work-item parent', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const epic = await item(fx, 'epic', 'Epic');
    const story = await item(fx, 'story', 'Story');
    await foldersService.fileWorkItem(story, { folderId: later.id }, fx.ctx);

    await workItemsService.moveWorkItem(story, { newParentId: epic }, fx.ctx);
    expect(await row(story)).toMatchObject({ parentId: epic, folderId: null });
  });
});

describe('folderRepository — trigger translation at the edge', () => {
  it('translates the tenancy and cycle markers into typed errors', async () => {
    const fx = await makeWorkItemFixture();
    const other = await secondProject(fx);
    const foreign = await foldersService.createFolder(
      { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
      fx.ctx,
    );
    const outer = await folder(fx, 'Outer');
    const inner = await folder(fx, 'Inner', outer.id);

    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        folderRepository.move(outer.id, { parentFolderId: foreign.id, position: 'b0' }, tx),
      ),
    ).rejects.toBeInstanceOf(CrossProjectFolderError);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) =>
        folderRepository.move(outer.id, { parentFolderId: inner.id, position: 'b0' }, tx),
      ),
    ).rejects.toBeInstanceOf(FolderCycleError);
    await expect(
      withWorkspaceContext(fx.ctx, (tx) => folderRepository.rename('no-such-folder', 'X', tx)),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
  });
});

describe('races', () => {
  it('surfaces a concurrent sibling-name collision as FolderNameTakenError, never a raw P2002', async () => {
    const fx = await makeWorkItemFixture();
    const results = await Promise.allSettled([folder(fx, 'Later'), folder(fx, 'later')]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(FolderNameTakenError);

    const renamed = await folder(fx, 'Other');
    const renames = await Promise.allSettled([
      foldersService.renameFolder(
        { projectId: fx.projectId, folderId: renamed.id, name: 'Other' },
        fx.ctx,
      ),
      folder(fx, 'Third'),
    ]);
    expect(renames.every((r) => r.status === 'fulfilled')).toBe(true);
  });

  it('lets exactly one of two cycle-forming concurrent moves land', async () => {
    const fx = await makeWorkItemFixture();
    const a = await folder(fx, 'A');
    const b = await folder(fx, 'B');
    const results = await Promise.allSettled([
      foldersService.moveFolder(
        { projectId: fx.projectId, folderId: a.id, targetParentFolderId: b.id },
        fx.ctx,
      ),
      foldersService.moveFolder(
        { projectId: fx.projectId, folderId: b.id, targetParentFolderId: a.id },
        fx.ctx,
      ),
    ]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(FolderCycleError);
  });
});

describe('the gate', () => {
  it('refuses a member without work_item:edit on every method, before reading any folder', async () => {
    const fx = await makeWorkItemFixture();
    const task = await item(fx, 'task', 'Task');
    const viewer = await createTestUser({ email: 'folder-viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id },
        tx,
      ),
    );
    await setWorkspaceRoleFor(viewer.id, fx.workspaceId, 'viewer');
    const ctx = { userId: viewer.id, workspaceId: fx.workspaceId };
    const projectId = fx.projectId;

    // Folder ids that do not exist: a refusal that were NOT the gate would be
    // FolderNotFoundError.
    // Started one at a time, so no refusal is left unobserved while an earlier
    // one is being asserted.
    const attempts: Array<() => Promise<unknown>> = [
      () => foldersService.createFolder({ projectId, parentFolderId: 'missing', name: 'X' }, ctx),
      () => foldersService.renameFolder({ projectId, folderId: 'missing', name: 'X' }, ctx),
      () =>
        foldersService.moveFolder(
          { projectId, folderId: 'missing', targetParentFolderId: null },
          ctx,
        ),
      () => foldersService.deleteFolder({ projectId, folderId: 'missing' }, ctx),
      () => foldersService.fileWorkItem(task, { folderId: 'missing' }, ctx),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    }
  });
});

// ── Pages in folders (Story MOTIR-5753 · MOTIR-7371) ─────────────────────────

const inProject = <T>(fx: WorkItemFixture, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  withWorkspaceContext({ ...fx.ctx, projectId: fx.projectId }, fn);

function page(fx: WorkItemFixture, parent: PagePlacement, title: string) {
  return inProject(fx, (tx) =>
    createPage(pageStoreFor(tx), systemClock, {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      actorId: fx.ctx.userId,
      title,
      parent,
    }),
  );
}

const inFolder = (folderId: string): PagePlacement => ({ kind: 'folder', folderId });

async function pageRow(id: string) {
  return adminDb.page.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      folderId: true,
      parentPageId: true,
      position: true,
      ancestorPageIds: true,
    },
  });
}

/** Code-unit order — the `COLLATE "C"` order page positions are minted and read in. */
const before = (a: string, b: string) => a < b;

async function lockWaiters(event?: string): Promise<number> {
  const rows = await adminDb.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_stat_activity
     WHERE datname = current_database()
       AND wait_event_type = 'Lock'
       AND (${event ?? null}::text IS NULL OR wait_event = ${event ?? null}::text)
  `;
  return Number(rows[0]!.n);
}

function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('deleteFolder — pages', () => {
  it('moves two filed pages up after the destination’s pages, in order, with the sub-page still under its page', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await folder(fx, 'Parent');
    const doomed = await folder(fx, 'Doomed', parent.id);
    const bystanderFolder = await folder(fx, 'Bystander');

    const existing = await page(fx, inFolder(parent.id), 'Already there');
    const first = await page(fx, inFolder(doomed.id), 'First');
    const second = await page(fx, inFolder(doomed.id), 'Second');
    const sub = await page(fx, { kind: 'page', pageId: second.id }, 'Sub');
    const subSub = await page(fx, { kind: 'page', pageId: sub.id }, 'Sub sub');
    const elsewhere = await page(fx, inFolder(bystanderFolder.id), 'Elsewhere');
    const atRoot = await page(fx, { kind: 'root' }, 'At root');
    const untouchedBefore = await Promise.all(
      [existing.id, sub.id, subSub.id, elsewhere.id, atRoot.id].map(pageRow),
    );

    const result = await foldersService.deleteFolder(
      { projectId: fx.projectId, folderId: doomed.id },
      fx.ctx,
    );
    expect(result).toEqual({
      deletedFolderId: doomed.id,
      destinationFolderId: parent.id,
      movedFolderIds: [],
      movedWorkItemIds: [],
      movedPageIds: [first.id, second.id],
    });

    const [movedFirst, movedSecond] = await Promise.all([pageRow(first.id), pageRow(second.id)]);
    expect(movedFirst).toMatchObject({
      folderId: parent.id,
      parentPageId: null,
      ancestorPageIds: [],
    });
    expect(movedSecond).toMatchObject({
      folderId: parent.id,
      parentPageId: null,
      ancestorPageIds: [],
    });
    // After the destination's own page, and in their prior relative order.
    expect(before(existing.position, movedFirst.position)).toBe(true);
    expect(before(movedFirst.position, movedSecond.position)).toBe(true);
    // The sub-pages, the bystanders and the destination's own page are unchanged.
    expect(await Promise.all(untouchedBefore.map((r) => pageRow(r.id)))).toEqual(untouchedBefore);
    expect(await pageRow(sub.id)).toMatchObject({ parentPageId: second.id, folderId: null });

    // The destination level reads back in that order.
    const level = await inProject(fx, (tx) =>
      pageRepository.findLevelAfter(
        fx.projectId,
        { kind: 'folder', folderId: parent.id },
        null,
        10,
        tx,
      ),
    );
    expect(level.map((r) => r.id)).toEqual([existing.id, first.id, second.id]);
    expect(level.find((r) => r.id === second.id)?.hasChildren).toBe(true);
    await expect(adminDb.folder.findUnique({ where: { id: doomed.id } })).resolves.toBeNull();
  });

  it('moves a root folder’s pages to the project root, after the root’s pages', async () => {
    const fx = await makeWorkItemFixture();
    const doomed = await folder(fx, 'Doomed');
    const rootPage = await page(fx, { kind: 'root' }, 'Root page');
    const filed = await page(fx, inFolder(doomed.id), 'Filed');

    const result = await foldersService.deleteFolder(
      { projectId: fx.projectId, folderId: doomed.id },
      fx.ctx,
    );
    expect(result).toMatchObject({ destinationFolderId: null, movedPageIds: [filed.id] });
    const moved = await pageRow(filed.id);
    expect(moved).toMatchObject({ folderId: null, parentPageId: null });
    expect(before(rootPage.position, moved.position)).toBe(true);
  });

  it('counts the pages a delete would move — a folder holding only pages is not empty', async () => {
    const fx = await makeWorkItemFixture();
    const holder = await folder(fx, 'Holder');
    const filed = await page(fx, inFolder(holder.id), 'Filed');
    await page(fx, { kind: 'page', pageId: filed.id }, 'Sub-page, not counted');
    await page(fx, inFolder(holder.id), 'Filed 2');

    await expect(
      foldersService.describeFolderDeletion(
        { projectId: fx.projectId, folderId: holder.id },
        fx.ctx,
      ),
    ).resolves.toEqual({
      folderId: holder.id,
      name: 'Holder',
      childFolderCount: 0,
      workItemCount: 0,
      pageCount: 2,
      destination: { folderId: null, name: null },
    });
  });

  it('a refused delete moves no page', async () => {
    const fx = await makeWorkItemFixture();
    const doomed = await folder(fx, 'Doomed');
    await folder(fx, 'Clash', doomed.id);
    await folder(fx, 'clash');
    const filed = await page(fx, inFolder(doomed.id), 'Filed');
    const was = await pageRow(filed.id);

    await expect(
      foldersService.deleteFolder({ projectId: fx.projectId, folderId: doomed.id }, fx.ctx),
    ).rejects.toBeInstanceOf(FolderNameTakenError);
    expect(await pageRow(filed.id)).toEqual(was);
  });

  it('races a page move INTO the folder: the move commits first, and the delete moves that page up', async () => {
    const fx = await makeWorkItemFixture();
    const parent = await folder(fx, 'Parent');
    const doomed = await folder(fx, 'Doomed', parent.id);
    const traveller = await page(fx, { kind: 'root' }, 'Traveller');
    const held = latch();
    const release = latch();

    const move = inProject(fx, async (tx) => {
      const out = await movePage(pageStoreFor(tx), {
        pageId: traveller.id,
        projectId: fx.projectId,
        parent: inFolder(doomed.id),
        actorId: fx.ctx.userId,
      });
      held.open();
      await release.opened;
      return out;
    });
    await held.opened;
    const del = foldersService.deleteFolder(
      { projectId: fx.projectId, folderId: doomed.id },
      fx.ctx,
    );
    // The delete is parked on the page-structure lock the move holds.
    await expect.poll(() => lockWaiters('advisory')).toBe(1);
    release.open();

    const [moved, deleted] = await Promise.all([move, del]);
    expect(moved.moved).toBe(true);
    expect(deleted.movedPageIds).toEqual([traveller.id]);
    expect(await pageRow(traveller.id)).toMatchObject({ folderId: parent.id, parentPageId: null });
    await expect(adminDb.folder.findUnique({ where: { id: doomed.id } })).resolves.toBeNull();
  });

  it('races a page move INTO the folder: the delete commits first, and the move is refused FOLDER_NOT_FOUND', async () => {
    const fx = await makeWorkItemFixture();
    const doomed = await folder(fx, 'Doomed');
    const traveller = await page(fx, { kind: 'root' }, 'Traveller');
    const was = await pageRow(traveller.id);
    const held = latch();
    const release = latch();

    // Hold the folder ROW, so the delete stops at its own row lock — AFTER it has
    // taken both structure locks.
    const blocker = inProject(fx, async (tx) => {
      await folderRepository.lockById(doomed.id, tx);
      held.open();
      await release.opened;
    });
    await held.opened;
    const del = foldersService.deleteFolder(
      { projectId: fx.projectId, folderId: doomed.id },
      fx.ctx,
    );
    await expect.poll(() => lockWaiters()).toBe(1);
    const move = inProject(fx, (tx) =>
      movePage(pageStoreFor(tx), {
        pageId: traveller.id,
        projectId: fx.projectId,
        parent: inFolder(doomed.id),
        actorId: fx.ctx.userId,
      }),
    );
    const moveSettled = move.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    // The move is parked on the page-structure lock the delete holds.
    await expect.poll(() => lockWaiters('advisory')).toBe(1);
    release.open();

    await blocker;
    await expect(del).resolves.toMatchObject({ deletedFolderId: doomed.id, movedPageIds: [] });
    expect(await moveSettled).toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(await pageRow(traveller.id)).toEqual(was);
  });
});

describe('folder level and counts — pages', () => {
  it('findLevelForPages marks a folder holding only pages as having children; /items’ findLevel does not', async () => {
    const fx = await makeWorkItemFixture();
    const pagesOnly = await folder(fx, 'Pages only');
    const itemsOnly = await folder(fx, 'Items only');
    const empty = await folder(fx, 'Empty');
    const nested = await folder(fx, 'Nested');
    await folder(fx, 'Child', nested.id);
    await page(fx, inFolder(pagesOnly.id), 'Spec');
    const task = await item(fx, 'task', 'Task');
    await foldersService.fileWorkItem(task, { folderId: itemsOnly.id }, fx.ctx);

    const forPages = await inProject(fx, (tx) =>
      folderRepository.findLevelForPages(fx.projectId, null, null, 50, tx),
    );
    const flags = new Map(forPages.map((r) => [r.id, r.hasChildren]));
    expect(flags.get(pagesOnly.id)).toBe(true);
    expect(flags.get(nested.id)).toBe(true);
    expect(flags.get(itemsOnly.id)).toBe(false);
    expect(flags.get(empty.id)).toBe(false);

    const forItems = await inProject(fx, (tx) =>
      folderRepository.findLevel(fx.projectId, fx.workspaceId, null, { take: 50, offset: 0 }, tx),
    );
    const itemFlags = new Map(forItems.map((r) => [r.id, r.hasChildren]));
    expect(itemFlags.get(pagesOnly.id)).toBe(false);
    expect(itemFlags.get(itemsOnly.id)).toBe(true);

    // A child level reads only that folder's children.
    const inside = await inProject(fx, (tx) =>
      folderRepository.findLevelForPages(fx.projectId, nested.id, null, 50, tx),
    );
    expect(inside.map((r) => r.name)).toEqual(['Child']);
  });

  it('findLevelForPages pages by keyset in (position, id) order, never repeating a row', async () => {
    const fx = await makeWorkItemFixture();
    const holder = await folder(fx, 'Holder');
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) made.push((await folder(fx, `F${i}`, holder.id)).id);

    const seen: string[] = [];
    let after: { position: string; id: string } | null = null;
    for (;;) {
      const cursor: { position: string; id: string } | null = after;
      const rows: Array<{ id: string; position: string }> = await inProject(fx, (tx) =>
        folderRepository.findLevelForPages(fx.projectId, holder.id, cursor, 2, tx),
      );
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.id));
      const last = rows[rows.length - 1]!;
      after = { position: last.position, id: last.id };
    }
    expect(seen).toEqual(made);
  });

  it('countDirectContents counts a folder’s filed pages, not their sub-pages', async () => {
    const fx = await makeWorkItemFixture();
    const holder = await folder(fx, 'Holder');
    const filed = await page(fx, inFolder(holder.id), 'Filed');
    await page(fx, { kind: 'page', pageId: filed.id }, 'Sub');
    await page(fx, inFolder(holder.id), 'Filed 2');

    const [counts] = await inProject(fx, (tx) =>
      folderRepository.countDirectContents([holder.id], tx),
    );
    expect(counts).toEqual({ id: holder.id, childFolderCount: 0, itemCount: 0, pageCount: 2 });
  });
});
