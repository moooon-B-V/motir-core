import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { FolderNameTakenError, SubtaskNeedsPlacementError } from '@/lib/folders/errors';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { seededBugsFolderId } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Deleting the destination folder CARRIES the bug destination up — Story
// MOTIR-4927 · Subtask MOTIR-5537. `foldersService.deleteFolder` already moves a
// folder's child folders and filed work items to its parent; the destination
// now follows them, in the same transaction, so the next filed bug lands exactly
// where the last ones were just moved. A refused delete changes nothing.

async function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

async function pointAt(fx: WorkItemFixture, folderId: string | null) {
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { bugDestinationFolderId: folderId },
  });
}

async function destinationOf(fx: WorkItemFixture) {
  const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
  return project.bugDestinationFolderId;
}

async function fileBug(fx: WorkItemFixture, folderId: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'bug', title: 'Crash on save', folderId },
    fx.ctx,
  );
}

async function folderOfItem(id: string) {
  const row = await adminDb.workItem.findUniqueOrThrow({ where: { id } });
  return row.folderId;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('deleteFolder carries the bug destination', () => {
  it('moves the destination to the PARENT when a nested destination folder is deleted — where its bugs went too', async () => {
    const fx = await makeWorkItemFixture();
    const bugs = await seededBugsFolderId(fx.projectId);
    const inbox = await folder(fx, 'Inbox', bugs);
    await pointAt(fx, inbox.id);
    const filed = await fileBug(fx, inbox.id);

    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: inbox.id }, fx.ctx);

    expect(await destinationOf(fx)).toBe(bugs);
    expect(await folderOfItem(filed.id)).toBe(bugs);
  });

  it('moves the destination to the project ROOT when the top-level destination folder is deleted', async () => {
    const fx = await makeWorkItemFixture();
    const bugs = await seededBugsFolderId(fx.projectId);
    expect(await destinationOf(fx)).toBe(bugs);
    const filed = await fileBug(fx, bugs);

    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: bugs }, fx.ctx);

    expect(await destinationOf(fx)).toBeNull();
    expect(await folderOfItem(filed.id)).toBeNull();
  });

  it('leaves the destination alone when a folder it does NOT name is deleted', async () => {
    const fx = await makeWorkItemFixture();
    const bugs = await seededBugsFolderId(fx.projectId);
    const later = await folder(fx, 'Later', null);

    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: later.id }, fx.ctx);

    expect(await destinationOf(fx)).toBe(bugs);
  });

  it('carries through the ID-ADDRESSED door too, which delegates to the same rule', async () => {
    const fx = await makeWorkItemFixture();
    const bugs = await seededBugsFolderId(fx.projectId);
    const inbox = await folder(fx, 'Inbox', bugs);
    await pointAt(fx, inbox.id);

    await foldersService.deleteFolderById(inbox.id, fx.ctx);

    expect(await destinationOf(fx)).toBe(bugs);
  });
});

describe('a refused delete changes neither the folder nor the destination', () => {
  it('on FolderNameTakenError — a child whose name collides at the parent', async () => {
    const fx = await makeWorkItemFixture();
    const bugs = await seededBugsFolderId(fx.projectId);
    const inbox = await folder(fx, 'Inbox', bugs);
    await folder(fx, 'Later', bugs);
    await folder(fx, 'later', inbox.id);
    await pointAt(fx, inbox.id);

    await expect(
      foldersService.deleteFolder({ projectId: fx.projectId, folderId: inbox.id }, fx.ctx),
    ).rejects.toBeInstanceOf(FolderNameTakenError);

    expect(await destinationOf(fx)).toBe(inbox.id);
    expect(await adminDb.folder.findUnique({ where: { id: inbox.id } })).not.toBeNull();
  });

  it('on SubtaskNeedsPlacementError — an unplaced subtask would land at the root', async () => {
    const fx = await makeWorkItemFixture();
    const bugs = await seededBugsFolderId(fx.projectId);
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Loose subtask', folderId: bugs },
      fx.ctx,
    );

    await expect(
      foldersService.deleteFolder({ projectId: fx.projectId, folderId: bugs }, fx.ctx),
    ).rejects.toBeInstanceOf(SubtaskNeedsPlacementError);

    expect(await destinationOf(fx)).toBe(bugs);
    expect(await adminDb.folder.findUnique({ where: { id: bugs } })).not.toBeNull();
  });
});

describe('the pointer is by id, so moving or renaming the destination changes nothing', () => {
  it('keeps the destination through a move to the root and a rename', async () => {
    const fx = await makeWorkItemFixture();
    const bugs = await seededBugsFolderId(fx.projectId);
    const inbox = await folder(fx, 'Inbox', bugs);
    await pointAt(fx, inbox.id);

    await foldersService.moveFolder(
      { projectId: fx.projectId, folderId: inbox.id, targetParentFolderId: null },
      fx.ctx,
    );
    await foldersService.renameFolder(
      { projectId: fx.projectId, folderId: inbox.id, name: 'Triage' },
      fx.ctx,
    );

    expect(await destinationOf(fx)).toBe(inbox.id);
  });
});
