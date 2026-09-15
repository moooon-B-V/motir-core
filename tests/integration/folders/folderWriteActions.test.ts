import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `createFolderAction` / `renameFolderAction` (Story MOTIR-5308 · MOTIR-5344) —
// the tree's inline folder name row's transport — on a REAL Postgres through the
// real service. Only the session and the active-project resolution are stubbed.
// Every expected refusal comes back as a `code`, never as a thrown error.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspacesService } from '@/lib/services/workspacesService';
import { createFolderAction, renameFolderAction } from '@/app/(authed)/items/actions';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
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

function actAs(fx: WorkItemFixture, userId: string) {
  session.current = { user: { id: userId } };
  activeCtx.current = { projectId: fx.projectId, userId, workspaceId: fx.workspaceId };
}

async function created(input: { parentFolderId: string | null; name: string }) {
  const res = await createFolderAction(input);
  if (!res.ok) throw new Error(`expected a folder, got ${res.code}`);
  return res.folder;
}

describe('createFolderAction + renameFolderAction', () => {
  it('creates at the root and inside a folder, and renames', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);

    const later = await created({ parentFolderId: null, name: 'Later' });
    expect(later).toMatchObject({ name: 'Later', parentFolderId: null, projectId: fx.projectId });
    const inside = await created({ parentFolderId: later.id, name: '2025' });
    expect(inside).toMatchObject({ name: '2025', parentFolderId: later.id });

    const renamed = await renameFolderAction({ folderId: later.id, name: 'Parked' });
    expect(renamed).toMatchObject({ ok: true, folder: { id: later.id, name: 'Parked' } });
    await expect(
      adminDb.folder.findUniqueOrThrow({ where: { id: later.id } }),
    ).resolves.toMatchObject({
      name: 'Parked',
    });
  });

  it('returns FOLDER_NAME_TAKEN for a case-insensitive sibling collision on create and on rename', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    await created({ parentFolderId: null, name: 'Parked' });
    const later = await created({ parentFolderId: null, name: 'Later' });

    await expect(
      createFolderAction({ parentFolderId: null, name: 'parked' }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'FOLDER_NAME_TAKEN',
    });
    await expect(renameFolderAction({ folderId: later.id, name: 'PARKED' })).resolves.toMatchObject(
      {
        ok: false,
        code: 'FOLDER_NAME_TAKEN',
      },
    );
    // Two it made, plus the seeded Bugs folder (MOTIR-4935).
    await expect(adminDb.folder.count({ where: { projectId: fx.projectId } })).resolves.toBe(3);
  });

  it('returns INVALID_FOLDER_NAME for a blank name and FOLDER_NOT_FOUND for a vanished folder', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);

    await expect(createFolderAction({ parentFolderId: null, name: '   ' })).resolves.toMatchObject({
      ok: false,
      code: 'INVALID_FOLDER_NAME',
    });
    await expect(
      renameFolderAction({ folderId: 'no-such-folder', name: 'X' }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'FOLDER_NOT_FOUND',
    });
  });

  it('refuses a member without work_item:edit on both writes', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const later = await created({ parentFolderId: null, name: 'Later' });

    const viewer = await createTestUser({ email: 'folder-writes-viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id, role: 'viewer' },
        tx,
      ),
    );
    actAs(fx, viewer.id);

    await expect(createFolderAction({ parentFolderId: null, name: 'Mine' })).resolves.toMatchObject(
      {
        ok: false,
        code: 'PROJECT_ACCESS_DENIED',
      },
    );
    await expect(renameFolderAction({ folderId: later.id, name: 'Mine' })).resolves.toMatchObject({
      ok: false,
      code: 'PROJECT_ACCESS_DENIED',
    });
    await expect(
      adminDb.folder.findUniqueOrThrow({ where: { id: later.id } }),
    ).resolves.toMatchObject({
      name: 'Later',
    });
  });
});
