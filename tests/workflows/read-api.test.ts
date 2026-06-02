import type { StatusCategory } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestProject } from '../fixtures/projectFixtures';
import { truncateAuthTables } from '../helpers/db';

// workflowsService + workflowsRepository read API (Story 2.2 · Subtask 2.2.3).
// Real Postgres (no mocks) — runs in CI. Seeds workflow rows DIRECTLY (2.2.2's
// seedDefaultWorkflow isn't shipped yet; the read API reads whatever rows
// exist, per the card). Proves: DTO-shaped reads, position ordering, the
// finding-#21 terminal-key surface, the four canTransition cells, and the
// explicit-workspaceId cross-tenant filter (finding #26).

beforeEach(async () => {
  // truncateAuthTables cascades workspace → project → workflow_status /
  // workflow_transition, so no dedicated workflow truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeStatus(args: {
  workspaceId: string;
  projectId: string;
  key: string;
  category: StatusCategory;
  position: string;
  isInitial?: boolean;
}): Promise<string> {
  const row = await db.workflowStatus.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      key: args.key,
      label: args.key,
      category: args.category,
      position: args.position,
      isInitial: args.isInitial ?? false,
    },
  });
  return row.id;
}

async function makeTransition(args: {
  workspaceId: string;
  projectId: string;
  fromStatusId: string;
  toStatusId: string;
}): Promise<void> {
  await db.workflowTransition.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      fromStatusId: args.fromStatusId,
      toStatusId: args.toStatusId,
    },
  });
}

interface Fixture {
  workspaceId: string;
  otherWorkspaceId: string;
  projectId: string;
}

// One workspace + project with a 4-status workflow (todo, in_progress, done,
// cancelled) and two transitions (todo→in_progress, in_progress→done), in
// restricted mode. A second empty workspace exists for cross-tenant probes.
async function makeFixture(): Promise<Fixture> {
  const userA = await usersService.createUser({
    email: 'wf-read-a@example.com',
    password: 'hunter2hunter2',
    name: 'WF Read A',
  });
  const userB = await usersService.createUser({
    email: 'wf-read-b@example.com',
    password: 'hunter2hunter2',
    name: 'WF Read B',
  });
  const w1 = await workspacesService.createWorkspace({ name: 'WF Read 1', ownerUserId: userA.id });
  const w2 = await workspacesService.createWorkspace({ name: 'WF Read 2', ownerUserId: userB.id });
  const project = await createTestProject({ workspaceId: w1.workspace.id, actorUserId: userA.id });

  const wsId = w1.workspace.id;
  const todoId = await makeStatus({
    workspaceId: wsId,
    projectId: project.id,
    key: 'todo',
    category: 'todo',
    position: 'a0',
    isInitial: true,
  });
  const inProgressId = await makeStatus({
    workspaceId: wsId,
    projectId: project.id,
    key: 'in_progress',
    category: 'in_progress',
    position: 'a1',
  });
  const doneId = await makeStatus({
    workspaceId: wsId,
    projectId: project.id,
    key: 'done',
    category: 'done',
    position: 'a2',
  });
  await makeStatus({
    workspaceId: wsId,
    projectId: project.id,
    key: 'cancelled',
    category: 'done',
    position: 'a3',
  });
  await makeTransition({
    workspaceId: wsId,
    projectId: project.id,
    fromStatusId: todoId,
    toStatusId: inProgressId,
  });
  await makeTransition({
    workspaceId: wsId,
    projectId: project.id,
    fromStatusId: inProgressId,
    toStatusId: doneId,
  });

  return {
    workspaceId: wsId,
    otherWorkspaceId: w2.workspace.id,
    projectId: project.id,
  };
}

describe('workflowsService.getWorkflow', () => {
  it('returns statuses (position-ordered), transitions, and policyMode', async () => {
    const fx = await makeFixture();
    const wf = await workflowsService.getWorkflow(fx.projectId, fx.workspaceId);
    expect(wf.policyMode).toBe('restricted');
    expect(wf.statuses.map((s) => s.key)).toEqual(['todo', 'in_progress', 'done', 'cancelled']);
    expect(wf.transitions).toHaveLength(2);
    // DTO shape — no Prisma-only fields (workspaceId / timestamps) leak.
    const todo = wf.statuses.find((s) => s.key === 'todo');
    expect(todo).toBeDefined();
    expect(Object.keys(todo ?? {}).sort()).toEqual(
      ['category', 'color', 'id', 'isInitial', 'key', 'label', 'position', 'projectId'].sort(),
    );
    expect(todo?.isInitial).toBe(true);
  });

  it('throws ProjectNotFoundError for a cross-workspace project (no-existence-leak)', async () => {
    const fx = await makeFixture();
    await expect(workflowsService.getWorkflow(fx.projectId, fx.otherWorkspaceId)).rejects.toThrow(
      ProjectNotFoundError,
    );
  });

  it('throws ProjectNotFoundError for a non-existent project', async () => {
    const fx = await makeFixture();
    await expect(workflowsService.getWorkflow('does-not-exist', fx.workspaceId)).rejects.toThrow(
      ProjectNotFoundError,
    );
  });
});

describe('workflowsService.listStatusesByProject', () => {
  it('returns the statuses ordered by position', async () => {
    const fx = await makeFixture();
    const statuses = await workflowsService.listStatusesByProject(fx.projectId, fx.workspaceId);
    expect(statuses.map((s) => s.key)).toEqual(['todo', 'in_progress', 'done', 'cancelled']);
  });

  it('returns [] for a cross-workspace project', async () => {
    const fx = await makeFixture();
    const statuses = await workflowsService.listStatusesByProject(
      fx.projectId,
      fx.otherWorkspaceId,
    );
    expect(statuses).toEqual([]);
  });
});

describe('workflowsService.getStatusByKey', () => {
  it('resolves an existing key to its status DTO', async () => {
    const fx = await makeFixture();
    const status = await workflowsService.getStatusByKey(fx.projectId, 'done', fx.workspaceId);
    expect(status?.key).toBe('done');
    expect(status?.category).toBe('done');
  });

  it('returns null for an unknown key', async () => {
    const fx = await makeFixture();
    expect(await workflowsService.getStatusByKey(fx.projectId, 'nope', fx.workspaceId)).toBeNull();
  });

  it('returns null for a cross-workspace lookup', async () => {
    const fx = await makeFixture();
    expect(
      await workflowsService.getStatusByKey(fx.projectId, 'done', fx.otherWorkspaceId),
    ).toBeNull();
  });
});

describe('workflowsService.getTerminalStatusKeys (finding #21 surface)', () => {
  it('returns every category=done key — done AND cancelled out of the box', async () => {
    const fx = await makeFixture();
    const terminal = await workflowsService.getTerminalStatusKeys(fx.projectId, fx.workspaceId);
    expect(terminal).toEqual(new Set(['done', 'cancelled']));
  });

  it('grows when a new category=done status is added', async () => {
    const fx = await makeFixture();
    await makeStatus({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'wont_fix',
      category: 'done',
      position: 'a4',
    });
    const terminal = await workflowsService.getTerminalStatusKeys(fx.projectId, fx.workspaceId);
    expect(terminal).toEqual(new Set(['done', 'cancelled', 'wont_fix']));
  });

  it('returns an empty set for a cross-workspace project', async () => {
    const fx = await makeFixture();
    const terminal = await workflowsService.getTerminalStatusKeys(
      fx.projectId,
      fx.otherWorkspaceId,
    );
    expect(terminal).toEqual(new Set());
  });
});

describe('workflowsService.canTransition (the four matrix cells)', () => {
  it('restricted + transition row exists → true', async () => {
    const fx = await makeFixture();
    expect(
      await workflowsService.canTransition(fx.projectId, 'todo', 'in_progress', fx.workspaceId),
    ).toBe(true);
  });

  it('restricted + no transition row → false', async () => {
    const fx = await makeFixture();
    expect(await workflowsService.canTransition(fx.projectId, 'todo', 'done', fx.workspaceId)).toBe(
      false,
    );
  });

  it('fromKey === toKey → true regardless of mode (no-op move)', async () => {
    const fx = await makeFixture();
    expect(await workflowsService.canTransition(fx.projectId, 'done', 'done', fx.workspaceId)).toBe(
      true,
    );
  });

  it('open mode → true for any (from, to), even without a transition row', async () => {
    const fx = await makeFixture();
    await db.project.update({
      where: { id: fx.projectId },
      data: { workflowPolicyMode: 'open' },
    });
    expect(await workflowsService.canTransition(fx.projectId, 'todo', 'done', fx.workspaceId)).toBe(
      true,
    );
    // open is checked before status resolution, so even unknown keys pass.
    expect(
      await workflowsService.canTransition(fx.projectId, 'ghost', 'phantom', fx.workspaceId),
    ).toBe(true);
  });

  it('unknown status key in restricted mode → false', async () => {
    const fx = await makeFixture();
    expect(
      await workflowsService.canTransition(fx.projectId, 'todo', 'phantom', fx.workspaceId),
    ).toBe(false);
  });

  it('cross-workspace project → false (a move in an unseen project is never legal)', async () => {
    const fx = await makeFixture();
    expect(
      await workflowsService.canTransition(
        fx.projectId,
        'todo',
        'in_progress',
        fx.otherWorkspaceId,
      ),
    ).toBe(false);
  });
});

describe('workflowsRepository — explicit workspaceId filter (finding #26)', () => {
  it('findStatuses with the wrong workspaceId returns []', async () => {
    const fx = await makeFixture();
    const rows = await workflowsRepository.findStatuses(fx.projectId, fx.otherWorkspaceId);
    expect(rows).toEqual([]);
  });

  it('findTransitions with the wrong workspaceId returns []', async () => {
    const fx = await makeFixture();
    const rows = await workflowsRepository.findTransitions(fx.projectId, fx.otherWorkspaceId);
    expect(rows).toEqual([]);
  });

  it('findStatusByKey with the wrong workspaceId returns null', async () => {
    const fx = await makeFixture();
    const row = await workflowsRepository.findStatusByKey(
      fx.projectId,
      'todo',
      fx.otherWorkspaceId,
    );
    expect(row).toBeNull();
  });
});
