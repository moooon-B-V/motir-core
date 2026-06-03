import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { NotProjectAdminError } from '@/lib/workflows/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// Restore default workflow — ADDITIVE merge (Story 2.2 · Subtask 2.2.9). Real
// Postgres. createTestProject auto-seeds the default workflow (6 statuses, 15
// transitions, todo initial); the tests edit it then restore.

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

async function makeFixture(): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: 'wf-restore@example.com',
    password: 'hunter2hunter2',
    name: 'WF Restore',
  });
  const ws = await workspacesService.createWorkspace({ name: 'WF Restore', ownerUserId: owner.id });
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: owner.id });
  return { ownerId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
}

describe('restoreDefaultWorkflow — additive merge', () => {
  it('re-adds missing default statuses + transitions, keeps customizations, is idempotent', async () => {
    const fx = await makeFixture();

    // Customize: delete two defaults (cascades their transitions via the FK),
    // remove a transition between survivors, add a custom status.
    await db.workflowStatus.deleteMany({
      where: { projectId: fx.projectId, key: { in: ['in_review', 'cancelled'] } },
    });
    // Drop the todo→in_progress edge (both endpoints survive).
    const statuses = await db.workflowStatus.findMany({ where: { projectId: fx.projectId } });
    const idOf = (k: string) => statuses.find((s) => s.key === k)!.id;
    await db.workflowTransition.deleteMany({
      where: {
        projectId: fx.projectId,
        fromStatusId: idOf('todo'),
        toStatusId: idOf('in_progress'),
      },
    });
    await db.workflowStatus.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'on_hold',
        label: 'On Hold',
        category: 'todo',
        position: 'zz',
      },
    });

    const result = await workflowsService.restoreDefaultWorkflow({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(result.statusesAdded).toBe(2); // in_review + cancelled
    expect(result.transitionsAdded).toBe(9); // 8 cascaded with the 2 statuses + todo→in_progress

    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    // The two defaults are back; the custom status survives.
    const keys = wf.statuses.map((s) => s.key);
    expect(keys).toContain('in_review');
    expect(keys).toContain('cancelled');
    expect(keys).toContain('on_hold');
    expect(wf.statuses).toHaveLength(7); // 6 defaults + on_hold
    expect(wf.transitions).toHaveLength(15); // full default graph restored
    // Exactly one initial, still todo.
    expect(wf.statuses.filter((s) => s.isInitial).map((s) => s.key)).toEqual(['todo']);

    // Idempotent: a second restore changes nothing.
    const again = await workflowsService.restoreDefaultWorkflow({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(again).toEqual({ statusesAdded: 0, transitionsAdded: 0 });
    const wf2 = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf2.statuses).toHaveLength(7);
    expect(wf2.transitions).toHaveLength(15);
  });

  it('a renamed default is matched by key and NOT reverted', async () => {
    const fx = await makeFixture();
    await db.workflowStatus.updateMany({
      where: { projectId: fx.projectId, key: 'in_progress' },
      data: { label: 'Doing' },
    });
    await workflowsService.restoreDefaultWorkflow({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.statuses.find((s) => s.key === 'in_progress')?.label).toBe('Doing');
  });

  it('is a no-op on a pristine default-seeded project', async () => {
    const fx = await makeFixture();
    const result = await workflowsService.restoreDefaultWorkflow({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });
    expect(result).toEqual({ statusesAdded: 0, transitionsAdded: 0 });
  });

  it('is admin-gated: a non-owner member is rejected', async () => {
    const fx = await makeFixture();
    const member = await usersService.createUser({
      email: 'wf-restore-member@example.com',
      password: 'hunter2hunter2',
      name: 'Member',
    });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await expect(
      workflowsService.restoreDefaultWorkflow({
        userId: member.id,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).rejects.toThrow(NotProjectAdminError);
  });
});
