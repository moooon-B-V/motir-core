import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { folderRepository } from '@/lib/repositories/folderRepository';
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
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id, role: 'viewer' },
        tx,
      ),
    );
    const ctx = { userId: viewer.id, workspaceId: fx.workspaceId };
    const projectId = fx.projectId;

    // Folder ids that do not exist: a refusal that were NOT the gate would be
    // FolderNotFoundError.
    const attempts = [
      foldersService.createFolder({ projectId, parentFolderId: 'missing', name: 'X' }, ctx),
      foldersService.renameFolder({ projectId, folderId: 'missing', name: 'X' }, ctx),
      foldersService.moveFolder(
        { projectId, folderId: 'missing', targetParentFolderId: null },
        ctx,
      ),
      foldersService.deleteFolder({ projectId, folderId: 'missing' }, ctx),
      foldersService.fileWorkItem(task, { folderId: 'missing' }, ctx),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    }
  });
});
