import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { NotEpicError, WorkItemNotFoundError } from '@/lib/workItems/errors';
import { NotProjectAdminError } from '@/lib/projects/errors';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Service-layer tests for workItemsService.setEpicPrivacy (Story 6.14 · Subtask
// 6.14.7 — the project-admin write that sets/unsets an epic's
// `publicChildrenHidden` flag). Real Postgres, no DB mocks (CLAUDE.md). Covers:
// the admin-gated write (workspace-manager AND project-admin tiers pass; member
// / viewer are 403), the epic-only rejection, the unknown / cross-workspace
// 404, and the idempotent no-op. The full public-read EXCLUSION + member-bypass
// guarantee is 6.14.8's suite (this card is the write path + its gates only).

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** The owner-actor input for project-scoped calls on the fixture's project. */
function actorInput(fx: WorkItemFixture) {
  return { key: fx.projectIdentifier, actorUserId: fx.ownerId, ctx: fx.ctx };
}

/**
 * Add a user with a workspace role and (optionally) a project role — the SAME
 * helper shape definitionsService.test uses to exercise the 6.4 two-tier gate.
 */
async function addUser(
  fx: WorkItemFixture,
  email: string,
  wsRole: 'admin' | 'member',
  projectRole?: 'admin' | 'member' | 'viewer',
) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId, role: wsRole });
  if (projectRole) {
    await projectMembersService.addMember({
      ...actorInput(fx),
      targetUserId: user.id,
      role: projectRole,
    });
  }
  return { userId: user.id, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
}

describe('setEpicPrivacy — the admin write', () => {
  it('the workspace owner sets and unsets the flag (persisted)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Platform' });
    expect(epic.publicChildrenHidden).toBe(false);

    const set = await workItemsService.setEpicPrivacy(epic.id, true, fx.ctx);
    expect(set.publicChildrenHidden).toBe(true);
    expect((await workItemRepository.findById(epic.id))?.publicChildrenHidden).toBe(true);

    const unset = await workItemsService.setEpicPrivacy(epic.id, false, fx.ctx);
    expect(unset.publicChildrenHidden).toBe(false);
    expect((await workItemRepository.findById(epic.id))?.publicChildrenHidden).toBe(false);
  });

  it('a project admin who is NOT a workspace manager can set it', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Platform' });
    const projAdmin = await addUser(fx, 'proj-admin@example.com', 'member', 'admin');

    const set = await workItemsService.setEpicPrivacy(epic.id, true, projAdmin.ctx);
    expect(set.publicChildrenHidden).toBe(true);
  });

  it('a plain member, a project member, and a project viewer are 403', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Platform' });
    const plainMember = await addUser(fx, 'plain@example.com', 'member');
    const projMember = await addUser(fx, 'proj-member@example.com', 'member', 'member');
    const projViewer = await addUser(fx, 'proj-viewer@example.com', 'member', 'viewer');
    // A user with NO workspace membership at all — the gate's defense-in-depth
    // branch (no workspace row → no project-admin → rejected). In production RLS
    // 404s them first; the explicit gate is the backstop.
    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: 'hunter2hunter2',
      name: 'stranger',
    });
    const strangerActor = {
      ctx: { userId: stranger.id, workspaceId: fx.workspaceId },
    };

    for (const denied of [plainMember, projMember, projViewer, strangerActor]) {
      await expect(
        workItemsService.setEpicPrivacy(epic.id, true, denied.ctx),
      ).rejects.toBeInstanceOf(NotProjectAdminError);
    }
    // No write leaked through a denied call.
    expect((await workItemRepository.findById(epic.id))?.publicChildrenHidden).toBe(false);
  });

  it('rejects a non-epic target with NotEpicError and leaves the flag untouched', async () => {
    const fx = await makeWorkItemFixture();
    const task = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });

    await expect(workItemsService.setEpicPrivacy(task.id, true, fx.ctx)).rejects.toBeInstanceOf(
      NotEpicError,
    );
    expect((await workItemRepository.findById(task.id))?.publicChildrenHidden).toBe(false);
  });

  it('404s an unknown id and a cross-workspace epic (no existence leak)', async () => {
    const fx = await makeWorkItemFixture();
    await expect(
      workItemsService.setEpicPrivacy('00000000-0000-0000-0000-000000000000', true, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);

    // An epic in a DIFFERENT workspace is an indistinguishable 404 for fx's ctx.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherEpic = await createTestWorkItem(other, { kind: 'epic', title: 'Theirs' });
    await expect(
      workItemsService.setEpicPrivacy(otherEpic.id, true, fx.ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('is an idempotent no-op when the value is unchanged (no updatedAt bump)', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Platform' });

    const first = await workItemsService.setEpicPrivacy(epic.id, true, fx.ctx);
    const again = await workItemsService.setEpicPrivacy(epic.id, true, fx.ctx);

    expect(again.publicChildrenHidden).toBe(true);
    // The second set short-circuits before the write, so updatedAt is unchanged.
    expect(again.updatedAt).toBe(first.updatedAt);
  });
});
