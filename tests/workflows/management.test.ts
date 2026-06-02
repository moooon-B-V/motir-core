import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  CannotDeleteInitialStatusError,
  CannotDeleteLastTerminalStatusError,
  NotProjectAdminError,
  StatusInUseError,
  StatusKeyConflictError,
} from '@/lib/workflows/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// Workflow management writes (Story 2.2 · Subtask 2.2.5). Real Postgres. The
// fixture owner can manage; a member can't. Projects come from createTestProject
// (→ createProject, auto-seeded: todo[initial]/blocked/in_progress/in_review/
// done/cancelled, with done + cancelled both category=done).

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
    email: 'wf-mgmt-owner@example.com',
    password: 'hunter2hunter2',
    name: 'WF Owner',
  });
  const ws = await workspacesService.createWorkspace({ name: 'WF Mgmt', ownerUserId: owner.id });
  const project = await createTestProject({ workspaceId: ws.workspace.id, actorUserId: owner.id });
  return { ownerId: owner.id, workspaceId: ws.workspace.id, projectId: project.id };
}

async function statusId(fx: Fixture, key: string): Promise<string> {
  const s = await workflowsRepository.findStatusByKey(fx.projectId, key, fx.workspaceId);
  if (!s) throw new Error(`seeded status ${key} missing`);
  return s.id;
}

describe('assertProjectAdmin gate', () => {
  it('a non-owner member cannot manage the workflow', async () => {
    const fx = await makeFixture();
    const member = await usersService.createUser({
      email: 'wf-member@example.com',
      password: 'hunter2hunter2',
      name: 'WF Member',
    });
    await db.workspaceMembership.create({
      data: { userId: member.id, workspaceId: fx.workspaceId, role: 'member' },
    });
    await expect(
      workflowsService.setPolicyMode({
        userId: member.id,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        mode: 'open',
      }),
    ).rejects.toThrow(NotProjectAdminError);
  });
});

describe('createStatus', () => {
  it('appends a new status and rejects a duplicate key', async () => {
    const fx = await makeFixture();
    const created = await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'on_hold',
      label: 'On Hold',
      category: 'todo',
    });
    expect(created.key).toBe('on_hold');
    const all = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    expect(all.map((s) => s.key)).toContain('on_hold');
    expect(all[all.length - 1]!.key).toBe('on_hold'); // appended last

    await expect(
      workflowsService.createStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        key: 'todo',
        label: 'Dup',
        category: 'todo',
      }),
    ).rejects.toThrow(StatusKeyConflictError);
  });
});

describe('updateStatus', () => {
  it('renames a status', async () => {
    const fx = await makeFixture();
    const updated = await workflowsService.updateStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: await statusId(fx, 'in_review'),
      label: 'QA',
    });
    expect(updated.label).toBe('QA');
  });

  it('flipping isInitial atomically unsets the previous initial (index never sees two)', async () => {
    const fx = await makeFixture();
    await workflowsService.updateStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: await statusId(fx, 'blocked'),
      isInitial: true,
    });
    const all = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    const initials = all.filter((s) => s.isInitial).map((s) => s.key);
    expect(initials).toEqual(['blocked']); // exactly one, now `blocked`
  });
});

describe('deleteStatus protections', () => {
  it('refuses to delete the initial status', async () => {
    const fx = await makeFixture();
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: await statusId(fx, 'todo'),
      }),
    ).rejects.toThrow(CannotDeleteInitialStatusError);
  });

  it('refuses to delete a status still referenced by a work item', async () => {
    const fx = await makeFixture();
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'T' },
      { userId: fx.ownerId, workspaceId: fx.workspaceId },
    );
    // Park the item in in_review (a non-initial status) directly.
    await db.workItem.update({ where: { id: item.id }, data: { status: 'in_review' } });
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: await statusId(fx, 'in_review'),
      }),
    ).rejects.toThrow(StatusInUseError);
  });

  it('refuses to delete the LAST terminal status (but allows it while another remains)', async () => {
    const fx = await makeFixture();
    // Seed has two terminals (done + cancelled). Deleting cancelled is fine.
    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: await statusId(fx, 'cancelled'),
    });
    // Now `done` is the only terminal — deleting it is refused.
    await expect(
      workflowsService.deleteStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        statusId: await statusId(fx, 'done'),
      }),
    ).rejects.toThrow(CannotDeleteLastTerminalStatusError);
  });

  it('deletes a deletable status and cascades its transitions away', async () => {
    const fx = await makeFixture();
    const reviewId = await statusId(fx, 'in_review');
    await workflowsService.deleteStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      statusId: reviewId,
    });
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.statuses.map((s) => s.key)).not.toContain('in_review');
    // No surviving transition references the deleted status.
    expect(
      wf.transitions.some((t) => t.fromStatusId === reviewId || t.toStatusId === reviewId),
    ).toBe(false);
  });
});

describe('transitions', () => {
  it('adds a transition, is idempotent on a duplicate, and removes it', async () => {
    const fx = await makeFixture();
    const todoId = await statusId(fx, 'todo');
    const doneId = await statusId(fx, 'done');

    const added = await workflowsService.addTransition({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      fromStatusId: todoId,
      toStatusId: doneId,
    });
    // Duplicate → returns the SAME row (idempotent, no throw).
    const again = await workflowsService.addTransition({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      fromStatusId: todoId,
      toStatusId: doneId,
    });
    expect(again.id).toBe(added.id);

    await workflowsService.removeTransition({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      transitionId: added.id,
    });
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.transitions.some((t) => t.id === added.id)).toBe(false);
  });
});

describe('setPolicyMode', () => {
  it('flips the project policy mode', async () => {
    const fx = await makeFixture();
    const mode = await workflowsService.setPolicyMode({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      mode: 'open',
    });
    expect(mode).toBe('open');
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.policyMode).toBe('open');
  });
});
