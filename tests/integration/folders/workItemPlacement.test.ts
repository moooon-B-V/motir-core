import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  CrossProjectFolderError,
  FolderNotFoundError,
  PlacementConflictError,
} from '@/lib/folders/errors';
import { IllegalParentTypeError, StaleWorkItemError } from '@/lib/workItems/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// PLACEMENT in the service (Story MOTIR-5310 · MOTIR-5407), on a REAL Postgres
// through the ordinary workspace context — so the `work_item_parent_xor_folder`
// CHECK and the kind-parent trigger both stand behind every assertion here.
//
// What the card asks this file to prove, and where:
//   1  createWorkItem files an epic, a task and a subtask, each last at the
//      folder's level                                   → 'createWorkItem'
//   2  createWorkItem refuses parent+folder, another project's folder, an
//      unknown folder — writing nothing                 → 'createWorkItem'
//   3  updateWorkItem({ title, folderId }) is one revision; a stale token moves
//      neither; { folderId: null } returns a story to the root → 'updateWorkItem'
//   4  a work-item parent set on a FILED story clears the folder — the defect
//      that is a raw CHECK violation on origin/main     → 'the re-parent defect'
//   5  a filed subtask created, a filed task re-kinded to a subtask; unfiling a
//      subtask still refused                            → 'subtask as a filed root'

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

type Kind = 'epic' | 'story' | 'task' | 'bug' | 'subtask';

async function item(fx: WorkItemFixture, kind: Kind, title: string, parentId?: string) {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return dto.id;
}

function folder(fx: WorkItemFixture, name: string) {
  return foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name },
    fx.ctx,
  );
}

function row(id: string) {
  return adminDb.workItem.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      title: true,
      kind: true,
      parentId: true,
      folderId: true,
      position: true,
      updatedAt: true,
    },
  });
}

function revisions(fx: WorkItemFixture, id: string) {
  return withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    workItemRevisionRepository.listByWorkItem(id, {}, tx),
  );
}

async function foreignFolder(fx: WorkItemFixture) {
  const other = await projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ctx.userId,
    name: 'Second project',
    identifier: 'SECND',
  });
  return foldersService.createFolder(
    { projectId: other.id, parentFolderId: null, name: 'Elsewhere' },
    fx.ctx,
  );
}

describe('createWorkItem', () => {
  it('creates an epic, a task and a subtask filed, each appended last at the folder level', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    // An item already filed there, so "last" is measured against a real peer.
    const existing = await item(fx, 'story', 'Already filed');
    await foldersService.fileWorkItem(existing, { folderId: parked.id }, fx.ctx);

    const created: string[] = [];
    for (const kind of ['epic', 'task', 'subtask'] as const) {
      const dto = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind, title: `Filed ${kind}`, folderId: parked.id },
        fx.ctx,
      );
      expect(dto.parentId).toBeNull();
      created.push(dto.id);
    }

    const rows = await Promise.all([existing, ...created].map(row));
    for (const r of rows) expect(r).toMatchObject({ folderId: parked.id, parentId: null });
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.position > rows[i - 1]!.position).toBe(true);
    }

    const [createdRevision] = await revisions(fx, created[0]!);
    expect(createdRevision!.diff).toMatchObject({ folderId: { from: null, to: parked.id } });
  });

  it('refuses a parent AND a folder, another project’s folder and an unknown folder, writing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const foreign = await foreignFolder(fx);
    const story = await item(fx, 'story', 'Story');
    const before = await adminDb.workItem.count();

    await expect(
      workItemsService.createWorkItem(
        {
          projectId: fx.projectId,
          kind: 'task',
          title: 'Both',
          parentId: story,
          folderId: parked.id,
        },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(PlacementConflictError);
    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Foreign', folderId: foreign.id },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(CrossProjectFolderError);
    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title: 'Unknown', folderId: 'no-such-folder' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(FolderNotFoundError);

    expect(await adminDb.workItem.count()).toBe(before);
    // The refused creates burned no key either: the next item takes the next number.
    const next = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Next' },
      fx.ctx,
    );
    const storyRow = await adminDb.workItem.findUniqueOrThrow({ where: { id: story } });
    expect(next.key).toBe(storyRow.key + 1);
  });
});

describe('updateWorkItem', () => {
  it('changes a field and the folder in ONE revision, and a stale token changes neither', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const story = await item(fx, 'story', 'Story');
    const before = await row(story);

    await expect(
      workItemsService.updateWorkItem(story, { title: 'Renamed', folderId: parked.id }, fx.ctx, {
        expectedUpdatedAt: new Date(before.updatedAt.getTime() - 1000).toISOString(),
      }),
    ).rejects.toBeInstanceOf(StaleWorkItemError);
    expect(await row(story)).toMatchObject({ title: 'Story', folderId: null });

    const revisionsBefore = (await revisions(fx, story)).length;
    const dto = await workItemsService.updateWorkItem(
      story,
      { title: 'Renamed', folderId: parked.id },
      fx.ctx,
      { expectedUpdatedAt: before.updatedAt.toISOString() },
    );
    expect(dto.title).toBe('Renamed');
    expect(await row(story)).toMatchObject({
      title: 'Renamed',
      folderId: parked.id,
      parentId: null,
    });

    const after = await revisions(fx, story);
    expect(after).toHaveLength(revisionsBefore + 1);
    expect(after[0]!.diff).toMatchObject({
      title: { from: 'Story', to: 'Renamed' },
      folderId: { from: null, to: parked.id },
    });
  });

  it('files an item out of its work-item parent, and { folderId: null } returns a filed story to the root', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const epic = await item(fx, 'epic', 'Epic');
    const story = await item(fx, 'story', 'Story', epic);

    await workItemsService.updateWorkItem(story, { folderId: parked.id }, fx.ctx);
    expect(await row(story)).toMatchObject({ folderId: parked.id, parentId: null });
    expect((await revisions(fx, story))[0]!.diff).toMatchObject({
      parentId: { from: epic, to: null },
      folderId: { from: null, to: parked.id },
    });

    // Filing again into the same folder, and unfiling an unfiled item, are no-ops.
    const count = (await revisions(fx, story)).length;
    await workItemsService.updateWorkItem(story, { folderId: parked.id }, fx.ctx);

    await workItemsService.updateWorkItem(story, { folderId: null }, fx.ctx);
    expect(await row(story)).toMatchObject({ folderId: null, parentId: null });
    await workItemsService.updateWorkItem(story, { folderId: null }, fx.ctx);
    expect(await revisions(fx, story)).toHaveLength(count + 1);
  });

  it('refuses a parent AND a folder, another project’s folder and an unknown folder', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const foreign = await foreignFolder(fx);
    const epic = await item(fx, 'epic', 'Epic');
    const story = await item(fx, 'story', 'Story');

    await expect(
      workItemsService.updateWorkItem(story, { parentId: epic, folderId: parked.id }, fx.ctx),
    ).rejects.toBeInstanceOf(PlacementConflictError);
    await expect(
      workItemsService.updateWorkItem(story, { folderId: foreign.id }, fx.ctx),
    ).rejects.toBeInstanceOf(CrossProjectFolderError);
    await expect(
      workItemsService.updateWorkItem(story, { folderId: 'no-such-folder' }, fx.ctx),
    ).rejects.toBeInstanceOf(FolderNotFoundError);
    expect(await row(story)).toMatchObject({ folderId: null, parentId: null });
  });
});

describe('the re-parent defect', () => {
  it('sets a work-item parent on a FILED story: the folder clears in the same write and revision', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');
    const epic = await item(fx, 'epic', 'Epic');
    const story = await item(fx, 'story', 'Story');
    await foldersService.fileWorkItem(story, { folderId: parked.id }, fx.ctx);

    await workItemsService.updateWorkItem(story, { parentId: epic }, fx.ctx);

    expect(await row(story)).toMatchObject({ parentId: epic, folderId: null });
    expect((await revisions(fx, story))[0]!.diff).toMatchObject({
      parentId: { from: null, to: epic },
      folderId: { from: parked.id, to: null },
    });
  });
});

describe('subtask as a filed root', () => {
  it('creates a filed subtask and re-kinds a filed task to a subtask; unfiling a subtask is still refused', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await folder(fx, 'Parked');

    const subtask = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'subtask', title: 'Filed subtask', folderId: parked.id },
      fx.ctx,
    );
    expect(await row(subtask.id)).toMatchObject({ kind: 'subtask', folderId: parked.id });

    const task = await item(fx, 'task', 'Task');
    await foldersService.fileWorkItem(task, { folderId: parked.id }, fx.ctx);
    await workItemsService.updateWorkItem(task, { kind: 'subtask' }, fx.ctx);
    expect(await row(task)).toMatchObject({ kind: 'subtask', folderId: parked.id, parentId: null });

    await expect(
      workItemsService.updateWorkItem(task, { folderId: null }, fx.ctx),
    ).rejects.toBeInstanceOf(IllegalParentTypeError);
    // An unfiled root subtask is still refused on create.
    await expect(
      workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'subtask', title: 'Orphan' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(IllegalParentTypeError);
    expect(await row(task)).toMatchObject({ folderId: parked.id });
  });
});
