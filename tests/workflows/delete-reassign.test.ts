import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  CannotDeleteInitialStatusError,
  InvalidReassignTargetError,
  NotProjectAdminError,
  StatusInUseError,
} from '@/lib/workflows/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// Delete-with-reassign (Story 2.3 · Subtask 2.3.1), real Postgres. Deleting an
// in-use CUSTOM status migrates every referencing work item (incl. archived) to
// a target status, writing one status-change revision each, then removes the
// status — all in one transaction. Defaults are protected (2.2.10) so this only
// ever runs for custom statuses; the initial/last-terminal guards still fire.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  ownerId: string;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(email = 'reassign-owner@example.com'): Promise<Fixture> {
  const owner = await usersService.createUser({ email, password: 'hunter2hunter2', name: 'Owner' });
  const ws = await workspacesService.createWorkspace({ name: 'Reassign', ownerUserId: owner.id });
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: owner.id });
  return { ownerId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
}

async function seededStatusId(fx: Fixture, key: string): Promise<string> {
  const s = await workflowsRepository.findStatusByKey(fx.projectId, key, fx.workspaceId);
  if (!s) throw new Error(`seeded status ${key} missing`);
  return s.id;
}

async function makeCustomStatus(fx: Fixture, key: string, label = key) {
  return workflowsService.createStatus({
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    key,
    label,
    category: 'todo',
  });
}

/** Create N work items and force their status string to `statusKey` directly
 * (bypassing transition validation — same shortcut the management tests use). */
async function makeItemsWithStatus(fx: Fixture, statusKey: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `T${i}` },
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
    );
    await db.workItem.update({ where: { id: item.id }, data: { status: statusKey } });
    ids.push(item.id);
  }
  return ids;
}

describe('deleteStatus — delete-with-reassign (2.3.1)', () => {
  it('migrates every referencing item to the target, writes a revision each, then removes the status', async () => {
    const fx = await makeFixture();
    const triage = await makeCustomStatus(fx, 'triage', 'Triage');
    const ids = await makeItemsWithStatus(fx, 'triage', 3);
    const todoId = await seededStatusId(fx, 'todo');

    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: triage.id,
      reassignToStatusId: todoId,
    });

    // Every item migrated to the target key.
    for (const id of ids) {
      const row = await db.workItem.findUnique({ where: { id } });
      expect(row?.status).toBe('todo');
      // Exactly one 'updated' revision per item — the migration. (createWorkItem
      // already wrote a 'created' revision whose diff ALSO carries a `status`
      // field, so we key off changeKind, not the mere presence of `status`.)
      const revs = await db.workItemRevision.findMany({ where: { workItemId: id } });
      const statusRevs = revs.filter((r) => r.changeKind === 'updated');
      expect(statusRevs).toHaveLength(1);
      expect(statusRevs[0]!.diff).toEqual({ status: { from: 'triage', to: 'todo' } });
    }

    // Status gone.
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.statuses.map((s) => s.key)).not.toContain('triage');
  });

  it('also migrates ARCHIVED referencing items (their status still points at the deleted key)', async () => {
    const fx = await makeFixture();
    const triage = await makeCustomStatus(fx, 'triage');
    const [activeId] = await makeItemsWithStatus(fx, 'triage', 1);
    const archived = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'archived' },
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
    );
    await db.workItem.update({
      where: { id: archived.id },
      data: { status: 'triage', archivedAt: new Date() },
    });
    const todoId = await seededStatusId(fx, 'todo');

    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: triage.id,
      reassignToStatusId: todoId,
    });

    expect((await db.workItem.findUnique({ where: { id: activeId! } }))?.status).toBe('todo');
    expect((await db.workItem.findUnique({ where: { id: archived.id } }))?.status).toBe('todo');
  });

  it('without a target, an in-use status still throws StatusInUseError (the UI cue)', async () => {
    const fx = await makeFixture();
    const triage = await makeCustomStatus(fx, 'triage');
    await makeItemsWithStatus(fx, 'triage', 2);
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: triage.id,
      }),
    ).rejects.toThrow(StatusInUseError);
  });

  it('rejects an invalid target (self, cross-project, or non-existent) and migrates/deletes nothing', async () => {
    const fx = await makeFixture();
    const triage = await makeCustomStatus(fx, 'triage');
    const [itemId] = await makeItemsWithStatus(fx, 'triage', 1);

    // self-target
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: triage.id,
        reassignToStatusId: triage.id,
      }),
    ).rejects.toThrow(InvalidReassignTargetError);

    // a status in ANOTHER project
    const other = await makeFixture('reassign-other@example.com');
    const otherTodo = await seededStatusId(other, 'todo');
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: triage.id,
        reassignToStatusId: otherTodo,
      }),
    ).rejects.toThrow(InvalidReassignTargetError);

    // non-existent target
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: triage.id,
        reassignToStatusId: 'does-not-exist',
      }),
    ).rejects.toThrow(InvalidReassignTargetError);

    // Nothing changed: item keeps its status, the status still exists.
    expect((await db.workItem.findUnique({ where: { id: itemId! } }))?.status).toBe('triage');
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.statuses.map((s) => s.key)).toContain('triage');
  });

  it('the initial-status guard still fires even with a target supplied', async () => {
    const fx = await makeFixture();
    const intake = await makeCustomStatus(fx, 'intake', 'Intake');
    await workflowsService.updateStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: intake.id,
      isInitial: true,
    });
    await makeItemsWithStatus(fx, 'intake', 1);
    const todoId = await seededStatusId(fx, 'todo');
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: intake.id,
        reassignToStatusId: todoId,
      }),
    ).rejects.toThrow(CannotDeleteInitialStatusError);
  });

  it('is admin-gated — a non-member cannot reassign-and-delete', async () => {
    const fx = await makeFixture();
    const triage = await makeCustomStatus(fx, 'triage');
    await makeItemsWithStatus(fx, 'triage', 1);
    const todoId = await seededStatusId(fx, 'todo');
    const outsider = await usersService.createUser({
      email: 'outsider@example.com',
      password: 'hunter2hunter2',
      name: 'Outsider',
    });
    await expect(
      workflowsService.deleteStatus({
        userId: outsider.id,
        workspaceId: fx.workspaceId,
        statusId: triage.id,
        reassignToStatusId: todoId,
      }),
    ).rejects.toThrow(NotProjectAdminError);
  });
});
