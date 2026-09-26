import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `listFolderLevelAction` (Story MOTIR-5308 · MOTIR-5315) — the lazy tree's
// transport for one folder's level — driven on a REAL Postgres through the real
// service. Only the session and the active-project resolution are stubbed (a test
// has no cookies), exactly as the other Server Action tests do.
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
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { listFolderLevelAction } from '@/app/(authed)/items/actions';
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

describe('listFolderLevelAction', () => {
  it("returns a nested folder's level — its child folders, then its filed work items", async () => {
    const fx = await makeWorkItemFixture();
    const later = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Later' },
      fx.ctx,
    );
    const y2025 = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: later.id, name: '2025' },
      fx.ctx,
    );
    const q1 = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: y2025.id, name: 'Q1' },
      fx.ctx,
    );
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Filed task' },
      fx.ctx,
    );
    await foldersService.fileWorkItem(task.id, { folderId: y2025.id }, fx.ctx);
    actAs(fx, fx.ctx.userId);

    const result = await listFolderLevelAction({ folderId: y2025.id, sortParam: 'key:asc' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.level.total).toBe(2);
    expect(result.level.rows.map((r) => [r.kind, r.id])).toEqual([
      ['folder', q1.id],
      ['task', task.id],
    ]);
  });

  it('answers a vanished folder with a benign error', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);

    await expect(
      listFolderLevelAction({ folderId: 'no-such-folder', sortParam: 'key:asc' }),
    ).resolves.toEqual({ ok: false, error: 'That folder no longer exists.' });
  });

  it('refuses a member of the workspace who is not on the project', async () => {
    const fx = await makeWorkItemFixture();
    const later = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Later' },
      fx.ctx,
    );
    // The project is made private to its members so a workspace member who is
    // NOT on it cannot browse it.
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    const outsider = await createTestUser({ email: 'level-outsider@ex.com', name: 'Outsider' });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });
    const viewer = await createTestUser({ email: 'level-viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id, role: 'viewer' },
        tx,
      ),
    );
    await setWorkspaceRoleFor(viewer.id, fx.workspaceId, 'viewer');

    actAs(fx, viewer.id);
    await expect(
      listFolderLevelAction({ folderId: later.id, sortParam: 'key:asc' }),
    ).resolves.toMatchObject({ ok: true });

    actAs(fx, outsider.id);
    await expect(
      listFolderLevelAction({ folderId: later.id, sortParam: 'key:asc' }),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});
