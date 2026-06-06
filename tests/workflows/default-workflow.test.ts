import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workflowsService } from '@/lib/services/workflowsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { DEFAULT_STATUSES, DEFAULT_TRANSITIONS } from '@/lib/workflows/defaultWorkflow';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { truncateAuthTables } from '../helpers/db';

// Default-workflow seed (Story 2.2 · Subtask 2.2.2). Real Postgres — runs in
// CI. Proves the typed default constant, the seed wired into createProject
// (same transaction → atomic), the display ordering, the finding-#21 terminal
// set, and the one-off backfill.

const DISPLAY_ORDER = ['todo', 'blocked', 'in_progress', 'in_review', 'done', 'cancelled'];

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeWorkspaceAndUser(): Promise<{ userId: string; workspaceId: string }> {
  const user = await usersService.createUser({
    email: 'wf-default@example.com',
    password: 'hunter2hunter2',
    name: 'WF Default',
  });
  const ws = await workspacesService.createWorkspace({
    name: 'WF Default WS',
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: ws.workspace.id };
}

describe('defaultWorkflow constant', () => {
  it('defines six statuses in display order, exactly one initial (todo)', () => {
    expect(DEFAULT_STATUSES.map((s) => s.key)).toEqual(DISPLAY_ORDER);
    expect(DEFAULT_STATUSES.filter((s) => s.isInitial).map((s) => s.key)).toEqual(['todo']);
  });

  it('assigns strictly-ascending fractional-index positions (declared order === sorted order)', () => {
    const positions = DEFAULT_STATUSES.map((s) => s.position);
    expect(positions).toEqual([...positions].sort());
    expect(new Set(positions).size).toBe(positions.length); // all distinct
  });

  it('defines fifteen transitions, each referencing a known status key (finding #45)', () => {
    expect(DEFAULT_TRANSITIONS).toHaveLength(15);
    const keys = new Set(DEFAULT_STATUSES.map((s) => s.key));
    for (const [from, to] of DEFAULT_TRANSITIONS) {
      expect(keys.has(from)).toBe(true);
      expect(keys.has(to)).toBe(true);
    }
    const pairs = DEFAULT_TRANSITIONS.map(([f, t]) => `${f}->${t}`);
    expect(new Set(pairs).size).toBe(pairs.length); // no duplicate edges
  });
});

describe('createProject seeds the default workflow (same transaction)', () => {
  it('a fresh project ends with 6 statuses + 15 transitions; todo is the initial status', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Seeded',
    });

    const [statusCount, transitionCount] = await Promise.all([
      db.workflowStatus.count({ where: { projectId: project.id } }),
      db.workflowTransition.count({ where: { projectId: project.id } }),
    ]);
    expect(statusCount).toBe(6);
    expect(transitionCount).toBe(15);

    const initials = await db.workflowStatus.findMany({
      where: { projectId: project.id, isInitial: true },
    });
    expect(initials.map((s) => s.key)).toEqual(['todo']);

    // Every status + transition carries the project's workspaceId (tenant tag).
    const statuses = await db.workflowStatus.findMany({ where: { projectId: project.id } });
    expect(statuses.every((s) => s.workspaceId === workspaceId)).toBe(true);
  });

  it('lists the six statuses in display order through getWorkflow (workspace-scoped read)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Ordered',
    });

    const wf = await workflowsService.getWorkflow(project.id, workspaceId);
    expect(wf.statuses.map((s) => s.key)).toEqual(DISPLAY_ORDER);
    expect(wf.transitions).toHaveLength(15);
    expect(wf.policyMode).toBe('restricted');
  });

  it('getTerminalStatusKeys returns {done, cancelled} out of the box (finding #21)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Terminal',
    });

    const terminal = await workflowsService.getTerminalStatusKeys(project.id, workspaceId);
    expect(terminal).toEqual(new Set(['done', 'cancelled']));
  });
});

describe('seed atomicity + the one-initial-per-project constraint', () => {
  it('re-seeding the same project rejects and rolls back (no partial rows persist)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'Reseed',
    });

    // A second seed collides on @@unique([projectId, key]) for the first status
    // ('todo'); the withWorkspaceContext transaction rolls back wholesale.
    await expect(
      withWorkspaceContext({ userId, workspaceId }, (tx) =>
        workflowsService.seedDefaultWorkflow(project.id, workspaceId, tx),
      ),
    ).rejects.toThrow();

    expect(await db.workflowStatus.count({ where: { projectId: project.id } })).toBe(6);
    expect(await db.workflowTransition.count({ where: { projectId: project.id } })).toBe(15);
  });

  it('a second initial status in the same project violates the partial-unique index (2.2.1)', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    const project = await projectsService.createProject({
      workspaceId,
      actorUserId: userId,
      name: 'SecondInitial',
    });

    await expect(
      db.workflowStatus.create({
        data: {
          workspaceId,
          projectId: project.id,
          key: 'todo_again',
          label: 'Todo Again',
          category: 'todo',
          position: 'z9',
          isInitial: true,
        },
      }),
    ).rejects.toThrow();
  });
});

describe('backfillDefaultWorkflow (one-off, idempotent)', () => {
  it('seeds a project that has no workflow, then no-ops on a second call', async () => {
    const { userId, workspaceId } = await makeWorkspaceAndUser();
    // A project row WITHOUT a workflow (bypasses createProject's seed) — mimics
    // a row predating this Story.
    const bare = await db.project.create({
      data: { workspaceId, name: 'Bare', slug: 'bare-proj', identifier: 'BARE' },
    });

    expect(await db.workflowStatus.count({ where: { projectId: bare.id } })).toBe(0);

    const seeded = await workflowsService.backfillDefaultWorkflow(bare.id, userId);
    expect(seeded).toBe(true);
    expect(await db.workflowStatus.count({ where: { projectId: bare.id } })).toBe(6);
    expect(await db.workflowTransition.count({ where: { projectId: bare.id } })).toBe(15);

    // Idempotent — already has a workflow, so the second call is a no-op.
    const again = await workflowsService.backfillDefaultWorkflow(bare.id, userId);
    expect(again).toBe(false);
    expect(await db.workflowStatus.count({ where: { projectId: bare.id } })).toBe(6);
  });

  it('throws ProjectNotFoundError for a project that does not exist (2.6.4)', async () => {
    const { userId } = await makeWorkspaceAndUser();
    await expect(
      workflowsService.backfillDefaultWorkflow('does-not-exist', userId),
    ).rejects.toThrow(ProjectNotFoundError);
  });
});
