import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `describeFolderDeletionAction` + `deleteFolderAction` (Story MOTIR-5308 ·
// MOTIR-5346) — the delete confirmation's read and the delete itself — on a REAL
// Postgres through the real service. Only the session and the active-project
// resolution are stubbed. Both delete refusals come back as codes, and a refused
// delete changes nothing.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { deleteFolderAction, describeFolderDeletionAction } from '@/app/(authed)/items/actions';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { setWorkspaceRoleFor } from '../../helpers/workspaceRoleFixtures';

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

function actAs(fx: WorkItemFixture, userId: string) {
  session.current = { user: { id: userId } };
  activeCtx.current = { projectId: fx.projectId, userId, workspaceId: fx.workspaceId };
}

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

async function workItem(
  fx: WorkItemFixture,
  kind: 'task' | 'subtask',
  title: string,
  opts: { folderId?: string; parentId?: string } = {},
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(opts.parentId ? { parentId: opts.parentId } : {}) },
    fx.ctx,
  );
  if (opts.folderId) await foldersService.fileWorkItem(dto.id, { folderId: opts.folderId }, fx.ctx);
  return dto.id;
}

describe('deleteFolderAction', () => {
  it('moves two child folders and three work items to the parent, and changes nothing else', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const later = await folder(fx, 'Later');
    const bystander = await folder(fx, 'Bystander');
    const doomed = await folder(fx, 'Doomed', later.id);
    const childA = await folder(fx, 'Child A', doomed.id);
    const childB = await folder(fx, 'Child B', doomed.id);
    const grandchild = await folder(fx, 'Grandchild', childA.id);
    const items = [
      await workItem(fx, 'task', 'One', { folderId: doomed.id }),
      await workItem(fx, 'task', 'Two', { folderId: doomed.id }),
      await workItem(fx, 'task', 'Three', { folderId: doomed.id }),
    ];
    const untouched = await workItem(fx, 'task', 'Elsewhere', { folderId: bystander.id });

    await expect(describeFolderDeletionAction({ folderId: doomed.id })).resolves.toEqual({
      ok: true,
      preview: {
        folderId: doomed.id,
        name: 'Doomed',
        childFolderCount: 2,
        workItemCount: 3,
        destination: { folderId: later.id, name: 'Later' },
      },
    });

    const res = await deleteFolderAction({ folderId: doomed.id });
    expect(res).toMatchObject({ ok: true, result: { destinationFolderId: later.id } });

    await expect(adminDb.folder.findUnique({ where: { id: doomed.id } })).resolves.toBeNull();
    const movedFolders = await adminDb.folder.findMany({
      where: { id: { in: [childA.id, childB.id] } },
      select: { parentFolderId: true },
    });
    expect(movedFolders.map((f) => f.parentFolderId)).toEqual([later.id, later.id]);
    const movedItems = await adminDb.workItem.findMany({
      where: { id: { in: items } },
      select: { folderId: true, parentId: true },
    });
    expect(movedItems).toHaveLength(3);
    expect(movedItems.every((i) => i.folderId === later.id && i.parentId === null)).toBe(true);
    // Nothing else changed: the grandchild keeps its parent, the bystander keeps its item.
    await expect(
      adminDb.folder.findUniqueOrThrow({ where: { id: grandchild.id } }),
    ).resolves.toMatchObject({ parentFolderId: childA.id });
    await expect(
      adminDb.workItem.findUniqueOrThrow({ where: { id: untouched } }),
    ).resolves.toMatchObject({ folderId: bystander.id });
    // Five it made, plus the seeded Bugs folder (MOTIR-4935).
    await expect(adminDb.folder.count({ where: { projectId: fx.projectId } })).resolves.toBe(6);
  });

  it('returns FOLDER_NAME_TAKEN, naming the child, when a child folder name is already at the destination — and deletes nothing', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const later = await folder(fx, 'Later');
    await folder(fx, 'Q1', later.id);
    const doomed = await folder(fx, 'Doomed', later.id);
    await folder(fx, 'Q1', doomed.id);

    await expect(deleteFolderAction({ folderId: doomed.id })).resolves.toMatchObject({
      ok: false,
      code: 'FOLDER_NAME_TAKEN',
      folderName: 'Q1',
    });
    await expect(adminDb.folder.findUnique({ where: { id: doomed.id } })).resolves.not.toBeNull();
  });

  it('returns SUBTASK_NEEDS_PLACEMENT for a root folder holding a filed subtask — and deletes nothing', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const root = await folder(fx, 'Root folder');
    const task = await workItem(fx, 'task', 'Parent task');
    const subtask = await workItem(fx, 'subtask', 'Filed subtask', {
      parentId: task,
      folderId: root.id,
    });

    await expect(deleteFolderAction({ folderId: root.id })).resolves.toMatchObject({
      ok: false,
      code: 'SUBTASK_NEEDS_PLACEMENT',
    });
    await expect(adminDb.folder.findUnique({ where: { id: root.id } })).resolves.not.toBeNull();
    await expect(
      adminDb.workItem.findUniqueOrThrow({ where: { id: subtask } }),
    ).resolves.toMatchObject({ folderId: root.id });
  });

  it('refuses a member without work_item:edit on the read and the delete', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const viewer = await createTestUser({ email: 'folder-delete-viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id, role: 'viewer' },
        tx,
      ),
    );
    await setWorkspaceRoleFor(viewer.id, fx.workspaceId, 'viewer');
    actAs(fx, viewer.id);

    await expect(describeFolderDeletionAction({ folderId: later.id })).resolves.toMatchObject({
      ok: false,
      code: 'PROJECT_ACCESS_DENIED',
    });
    await expect(deleteFolderAction({ folderId: later.id })).resolves.toMatchObject({
      ok: false,
      code: 'PROJECT_ACCESS_DENIED',
    });
    await expect(adminDb.folder.findUnique({ where: { id: later.id } })).resolves.not.toBeNull();
  });
});
