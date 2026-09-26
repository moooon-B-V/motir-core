import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `fileWorkItemAction` (Story MOTIR-5308 · MOTIR-5316) — the quick view's Folder
// field's write — on a REAL Postgres through the real service. Only the session
// and the active-project resolution are stubbed. It answers in the rail's own
// result shape: the success arm carries the row's new token, and every expected
// refusal comes back as a message rather than a thrown error.
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
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { fileWorkItemAction } from '@/app/(authed)/items/[key]/edit/actions';
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

function folder(fx: WorkItemFixture, name: string, projectId = fx.projectId) {
  return foldersService.createFolder({ projectId, parentFolderId: null, name }, fx.ctx);
}

async function workItem(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'task',
  title: string,
  parentId?: string,
) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

const row = (id: string) =>
  adminDb.workItem.findUniqueOrThrow({
    where: { id },
    select: { folderId: true, parentId: true, updatedAt: true },
  });

describe('fileWorkItemAction', () => {
  it('files an epic with its two stories: the token is the row’s, and the stories keep their epic', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const later = await folder(fx, 'Later');
    const epic = await workItem(fx, 'epic', 'Auth');
    const one = await workItem(fx, 'story', 'Sign in', epic.id);
    const two = await workItem(fx, 'story', 'Sign out', epic.id);

    const res = await fileWorkItemAction({ workItemId: epic.id, folderId: later.id });

    const epicRow = await row(epic.id);
    expect(res).toEqual({ ok: true, updatedAt: epicRow.updatedAt.toISOString() });
    expect(epicRow).toMatchObject({ folderId: later.id, parentId: null });
    await expect(row(one.id)).resolves.toMatchObject({ parentId: epic.id, folderId: null });
    await expect(row(two.id)).resolves.toMatchObject({ parentId: epic.id, folderId: null });
  });

  it('filing a story that had an epic parent clears the parent; No folder returns an item to the root', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const later = await folder(fx, 'Later');
    const epic = await workItem(fx, 'epic', 'Auth');
    const story = await workItem(fx, 'story', 'Sign in', epic.id);

    await expect(
      fileWorkItemAction({ workItemId: story.id, folderId: later.id }),
    ).resolves.toMatchObject({ ok: true });
    await expect(row(story.id)).resolves.toMatchObject({ folderId: later.id, parentId: null });

    await expect(
      fileWorkItemAction({ workItemId: story.id, folderId: null }),
    ).resolves.toMatchObject({ ok: true });
    await expect(row(story.id)).resolves.toMatchObject({ folderId: null, parentId: null });
  });

  it('refuses a folder in another project with the Folder field’s own message, and changes nothing', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx, fx.ctx.userId);
    const other = await projectsService.createProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ctx.userId,
      name: 'Second project',
      identifier: 'SECND',
    });
    const elsewhere = await folder(fx, 'Elsewhere', other.id);
    const item = await workItem(fx, 'task', 'Stays put');

    await expect(
      fileWorkItemAction({ workItemId: item.id, folderId: elsewhere.id }),
    ).resolves.toEqual({
      ok: false,
      error: 'That folder belongs to another project, so this work item stayed where it was.',
    });
    await expect(row(item.id)).resolves.toMatchObject({ folderId: null, parentId: null });
  });

  it('refuses a member without work_item:edit with the read-only wording', async () => {
    const fx = await makeWorkItemFixture();
    const later = await folder(fx, 'Later');
    const item = await workItem(fx, 'task', 'Not yours to file');
    const viewer = await createTestUser({ email: 'file-action-viewer@ex.com', name: 'Viewer' });
    await workspacesService.addMember({ userId: viewer.id, workspaceId: fx.workspaceId });
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      projectMembershipRepository.create(
        { workspaceId: fx.workspaceId, projectId: fx.projectId, userId: viewer.id, role: 'viewer' },
        tx,
      ),
    );
    await setWorkspaceRoleFor(viewer.id, fx.workspaceId, 'viewer');
    actAs(fx, viewer.id);

    await expect(fileWorkItemAction({ workItemId: item.id, folderId: later.id })).resolves.toEqual({
      ok: false,
      error: 'You have read-only access to this project',
    });
    await expect(row(item.id)).resolves.toMatchObject({ folderId: null });
  });
});
