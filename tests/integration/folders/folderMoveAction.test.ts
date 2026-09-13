import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `moveFolderAction` + `listProjectFoldersAction` (Story MOTIR-5308 ·
// MOTIR-5345) — the transport behind Move to… and Move up / Move down — on a
// REAL Postgres through the real service. Only the session and the active-project
// resolution are stubbed. Every expected refusal comes back as a `code`.
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
import { workspacesService } from '@/lib/services/workspacesService';
import { listProjectFoldersAction, moveFolderAction } from '@/app/(authed)/items/actions';
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

function folder(fx: WorkItemFixture, name: string, parentFolderId: string | null = null) {
  return foldersService.createFolder({ projectId: fx.projectId, parentFolderId, name }, fx.ctx);
}

/** The project's ROOT folder names, in display order, read back through the picker's action. */
async function rootOrder(): Promise<string[]> {
  const res = await listProjectFoldersAction();
  if (!res.ok) throw new Error(res.error);
  return res.data.folders.filter((f) => f.parentFolderId === null).map((f) => f.name);
}

describe('moveFolderAction', () => {
  it('moves a folder into a nested folder and back to the root', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const later = await folder(fx, 'Later');
    const research = await folder(fx, 'Research');
    const y2025 = await folder(fx, '2025', later.id);

    await expect(
      moveFolderAction({ folderId: y2025.id, targetParentFolderId: research.id }),
    ).resolves.toMatchObject({ ok: true, folder: { id: y2025.id, parentFolderId: research.id } });

    await expect(
      moveFolderAction({ folderId: y2025.id, targetParentFolderId: null }),
    ).resolves.toMatchObject({ ok: true, folder: { id: y2025.id, parentFolderId: null } });
    await expect(rootOrder()).resolves.toEqual(['Later', 'Research', '2025']);
  });

  it('reorders among three siblings with the before / after neighbours, read back in order', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const a = await folder(fx, 'A');
    const b = await folder(fx, 'B');
    const c = await folder(fx, 'C');

    // C up: between A and B.
    await expect(
      moveFolderAction({
        folderId: c.id,
        targetParentFolderId: null,
        beforeId: a.id,
        afterId: b.id,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(rootOrder()).resolves.toEqual(['A', 'C', 'B']);

    // A down: after C, before B.
    await expect(
      moveFolderAction({
        folderId: a.id,
        targetParentFolderId: null,
        beforeId: c.id,
        afterId: b.id,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(rootOrder()).resolves.toEqual(['C', 'A', 'B']);

    // B up to the top: nothing before it, C after it.
    await expect(
      moveFolderAction({
        folderId: b.id,
        targetParentFolderId: null,
        beforeId: null,
        afterId: c.id,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(rootOrder()).resolves.toEqual(['B', 'C', 'A']);
  });

  it('refuses a move into its own descendant with FOLDER_CYCLE, and into a clashing name with FOLDER_NAME_TAKEN', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const later = await folder(fx, 'Later');
    const y2025 = await folder(fx, '2025', later.id);
    const q1 = await folder(fx, 'Q1', y2025.id);
    const research = await folder(fx, 'Research');
    await folder(fx, 'Q1', research.id);

    await expect(
      moveFolderAction({ folderId: later.id, targetParentFolderId: q1.id }),
    ).resolves.toMatchObject({ ok: false, code: 'FOLDER_CYCLE' });
    await expect(
      moveFolderAction({ folderId: q1.id, targetParentFolderId: research.id }),
    ).resolves.toMatchObject({ ok: false, code: 'FOLDER_NAME_TAKEN' });
    await expect(adminDb.folder.findUniqueOrThrow({ where: { id: q1.id } })).resolves.toMatchObject(
      {
        parentFolderId: y2025.id,
      },
    );
  });

  it('refuses a member without work_item:edit, who can still read the picker list', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const research = await folder(fx, 'Research');
    const viewer = await createTestUser({ email: 'folder-move-viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id, role: 'viewer' },
        tx,
      ),
    );
    actAs(fx, viewer.id);

    await expect(
      moveFolderAction({ folderId: later.id, targetParentFolderId: research.id }),
    ).resolves.toMatchObject({ ok: false, code: 'PROJECT_ACCESS_DENIED' });
    await expect(listProjectFoldersAction()).resolves.toMatchObject({
      ok: true,
      data: { truncated: false },
    });
  });
});

describe('listProjectFoldersAction', () => {
  it('returns the project folders in tree order with their paths', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const later = await folder(fx, 'Later');
    await folder(fx, '2025', later.id);

    const res = await listProjectFoldersAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.folders.map((f) => f.path)).toEqual([['Later'], ['Later', '2025']]);
  });
});
