import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `getWorkItemPlacementAction` (Story MOTIR-5309 · MOTIR-5381) — the item page's
// placement channel's re-read — on a REAL Postgres through the real service. Only
// the session and the active-project resolution are stubbed. It answers with the
// placement read's own answer for an item the session can browse, and refuses an
// item in another project with the not-found shape, as a result rather than a throw.
const { session, activeCtx } = vi.hoisted(() => ({
  session: { current: null as unknown },
  activeCtx: { current: null as unknown },
}));
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

import { db } from '@/lib/db';
import { foldersService } from '@/lib/services/foldersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { getWorkItemPlacementAction } from '@/app/(authed)/items/[key]/edit/actions';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';
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

function actAs(fx: WorkItemFixture, userId = fx.ctx.userId) {
  session.current = { user: { id: userId } };
  activeCtx.current = {
    projectId: fx.projectId,
    userId,
    workspaceId: fx.workspaceId,
  };
}

describe('getWorkItemPlacementAction', () => {
  it('answers the placement read’s own answer for an item the session can browse', async () => {
    const fx = await makeWorkItemFixture();
    actAs(fx);
    const parked = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Parked' },
      fx.ctx,
    );
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Old import' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Map legacy fields', parentId: epic.id },
      fx.ctx,
    );
    await foldersService.fileWorkItem(epic.id, { folderId: parked.id }, fx.ctx);

    const res = await getWorkItemPlacementAction(story.id);

    expect(res).toEqual({
      ok: true,
      placement: await workItemsService.getWorkItemPlacement(fx.projectId, story.id, fx.ctx),
    });
    expect(res.ok && res.placement.placementFolder).toMatchObject({
      path: ['Parked'],
      via: { id: epic.id },
    });
  });

  it('refuses an item in another project with the not-found shape, without throwing', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreign = await workItemsService.createWorkItem(
      { projectId: other.projectId, kind: 'task', title: 'Foreign' },
      other.ctx,
    );
    actAs(fx);

    const res = await getWorkItemPlacementAction(foreign.id);

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toMatch(/not found/i);
  });

  it('refuses a workspace member who cannot browse the project as a result, never a throw', async () => {
    const fx = await makeWorkItemFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Behind the gate' },
      fx.ctx,
    );
    // Private to its members, so a workspace member who is NOT on it cannot browse it.
    await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'private' } });
    const outsider = await createTestUser({ email: 'placement-outsider@ex.com', name: 'Outsider' });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });
    actAs(fx, outsider.id);

    await expect(getWorkItemPlacementAction(item.id)).resolves.toEqual({
      ok: false,
      error: 'You have read-only access to this project',
    });
  });
});
