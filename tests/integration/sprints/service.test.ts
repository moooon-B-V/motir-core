import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { SprintState } from '@prisma/client';
import { db } from '@/lib/db';
import { sprintsService, assertSprintTransition } from '@/lib/services/sprintsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  CannotDeleteActiveSprintError,
  CannotModifyCompletedSprintError,
  InvalidSprintNameError,
  InvalidSprintTransitionError,
  NotSprintAdminError,
  SprintNotFoundError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';
import { createTestProject } from '../../fixtures/projectFixtures';
import { createTestWorkItem } from '../../fixtures/workItemFixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Service-layer tests for the Story-4.1 sprintsService (Subtask 4.1.3): sprint
// CRUD + the pure `assertSprintTransition` state-machine guard. Real Postgres
// (no mocks), per CLAUDE.md. The repository leaves are tested in
// `repository.test.ts`; the association / rank / bounded-read BEHAVIOUR is Story
// 4.1.4 + its dedicated 4.1.5 suite — here we prove the entity + the rules.
//
// Authorization: sprint management is workspace-OWNER-gated (finding #36;
// TODO(6.4)), mirroring boardsService — an owner succeeds, a plain member is
// denied. Tenancy (finding #26): a project from another workspace is a 404.

interface Fixture {
  ownerCtx: ServiceContext;
  memberCtx: ServiceContext;
  workspaceId: string;
  projectId: string;
}

async function makeFixture(label = 'a'): Promise<Fixture> {
  const owner = await usersService.createUser({
    email: `sprint-owner-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Sprint Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Sprint WS ${label}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });

  const member = await usersService.createUser({
    email: `sprint-member-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Sprint Member',
  });
  await db.workspaceMembership.create({
    data: { userId: member.id, workspaceId, role: 'member' },
  });

  return {
    ownerCtx: { userId: owner.id, workspaceId },
    memberCtx: { userId: member.id, workspaceId },
    workspaceId,
    projectId: project.id,
  };
}

/** Force a sprint into a state Story 4.4 would set (no service path here yet). */
async function forceState(sprintId: string, state: SprintState): Promise<void> {
  await db.sprint.update({ where: { id: sprintId }, data: { state } });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('sprintsService.createSprint', () => {
  it('creates a PLANNED sprint, default-named "Sprint <n>" with a monotonic sequence', async () => {
    const fx = await makeFixture('create');

    const first = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    expect(first.state).toBe('planned');
    expect(first.name).toBe('Sprint 1');
    expect(first.sequence).toBe(1);
    expect(first.issueCount).toBe(0);
    expect(first.startDate).toBeNull();
    expect(first.completedAt).toBeNull();

    const second = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    expect(second.name).toBe('Sprint 2');
    expect(second.sequence).toBe(2);
  });

  it('honours an explicit name, goal, and date window', async () => {
    const fx = await makeFixture('explicit');
    const sprint = await sprintsService.createSprint(
      fx.projectId,
      {
        name: '  Q3 Hardening  ',
        goal: 'Burn down the bug backlog',
        startDate: '2026-07-01T00:00:00.000Z',
        endDate: '2026-07-14T00:00:00.000Z',
      },
      fx.ownerCtx,
    );
    expect(sprint.name).toBe('Q3 Hardening'); // trimmed
    expect(sprint.goal).toBe('Burn down the bug backlog');
    expect(sprint.startDate).toBe('2026-07-01T00:00:00.000Z');
    expect(sprint.endDate).toBe('2026-07-14T00:00:00.000Z');
  });

  it('rejects a blank name (400)', async () => {
    const fx = await makeFixture('blank');
    await expect(
      sprintsService.createSprint(fx.projectId, { name: '   ' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(InvalidSprintNameError);
  });

  it('rejects endDate before startDate, and an unparseable date (422)', async () => {
    const fx = await makeFixture('window');
    await expect(
      sprintsService.createSprint(
        fx.projectId,
        { startDate: '2026-07-14T00:00:00.000Z', endDate: '2026-07-01T00:00:00.000Z' },
        fx.ownerCtx,
      ),
    ).rejects.toBeInstanceOf(SprintWindowInvalidError);
    await expect(
      sprintsService.createSprint(fx.projectId, { startDate: 'not-a-date' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(SprintWindowInvalidError);
  });

  it('denies a non-owner member (403)', async () => {
    const fx = await makeFixture('member');
    await expect(
      sprintsService.createSprint(fx.projectId, {}, fx.memberCtx),
    ).rejects.toBeInstanceOf(NotSprintAdminError);
  });

  it('404s a project in another workspace (no cross-tenant leak)', async () => {
    const fx = await makeFixture('tenant-a');
    const other = await makeFixture('tenant-b');
    // other.projectId is real, but fx.ownerCtx is a DIFFERENT workspace.
    await expect(
      sprintsService.createSprint(other.projectId, {}, fx.ownerCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('sprintsService.updateSprint', () => {
  it('renames, edits the goal, clears the goal with null, and adjusts the window', async () => {
    const fx = await makeFixture('update');
    const sprint = await sprintsService.createSprint(
      fx.projectId,
      { name: 'Original', goal: 'old goal' },
      fx.ownerCtx,
    );

    const renamed = await sprintsService.updateSprint(sprint.id, { name: 'Renamed' }, fx.ownerCtx);
    expect(renamed.name).toBe('Renamed');
    expect(renamed.goal).toBe('old goal'); // untouched

    const cleared = await sprintsService.updateSprint(sprint.id, { goal: null }, fx.ownerCtx);
    expect(cleared.goal).toBeNull();

    const windowed = await sprintsService.updateSprint(
      sprint.id,
      { startDate: '2026-08-01T00:00:00.000Z', endDate: '2026-08-15T00:00:00.000Z' },
      fx.ownerCtx,
    );
    expect(windowed.startDate).toBe('2026-08-01T00:00:00.000Z');
    expect(windowed.endDate).toBe('2026-08-15T00:00:00.000Z');
  });

  it('validates the EFFECTIVE window — a new endDate before the existing startDate is rejected', async () => {
    const fx = await makeFixture('eff-window');
    const sprint = await sprintsService.createSprint(
      fx.projectId,
      { startDate: '2026-08-10T00:00:00.000Z' },
      fx.ownerCtx,
    );
    await expect(
      sprintsService.updateSprint(sprint.id, { endDate: '2026-08-01T00:00:00.000Z' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(SprintWindowInvalidError);
  });

  it('rejects editing a COMPLETE sprint (409)', async () => {
    const fx = await makeFixture('complete');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    await forceState(sprint.id, 'complete');
    await expect(
      sprintsService.updateSprint(sprint.id, { name: 'Nope' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(CannotModifyCompletedSprintError);
  });

  it('404s an unknown sprint and denies a member', async () => {
    const fx = await makeFixture('update-guard');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    await expect(
      sprintsService.updateSprint('does-not-exist', { name: 'X' }, fx.ownerCtx),
    ).rejects.toBeInstanceOf(SprintNotFoundError);
    await expect(
      sprintsService.updateSprint(sprint.id, { name: 'X' }, fx.memberCtx),
    ).rejects.toBeInstanceOf(NotSprintAdminError);
  });
});

describe('sprintsService.deleteSprint', () => {
  it('deletes a planned sprint; its issues fall back to the backlog (SetNull)', async () => {
    const fx = await makeFixture('delete');
    // createTestWorkItem only reads ownerId / workspaceId / projectId /
    // projectIdentifier off the fixture — the rest of the WorkItemFixture shape
    // is unused here, so a minimal object (cast once) keeps the test focused.
    const workItemFx = {
      ownerId: fx.ownerCtx.userId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      projectIdentifier: 'PROD',
      ctx: fx.ownerCtx,
    } as unknown as WorkItemFixture;
    const item = await createTestWorkItem(workItemFx, { title: 'Carried issue', kind: 'task' });

    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    await db.$transaction((tx) => workItemRepository.setSprint(item.id, sprint.id, tx));
    expect(await workItemRepository.countSprintIssues(sprint.id, fx.workspaceId)).toBe(1);

    await sprintsService.deleteSprint(sprint.id, fx.ownerCtx);

    expect(await sprintRepository.findById(sprint.id, fx.workspaceId)).toBeNull();
    const reloaded = await db.workItem.findUnique({ where: { id: item.id } });
    expect(reloaded?.sprintId).toBeNull(); // fell back to the backlog, not deleted
  });

  it('rejects deleting the ACTIVE sprint (409)', async () => {
    const fx = await makeFixture('delete-active');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    await forceState(sprint.id, 'active');
    await expect(sprintsService.deleteSprint(sprint.id, fx.ownerCtx)).rejects.toBeInstanceOf(
      CannotDeleteActiveSprintError,
    );
  });

  it('404s an unknown sprint and denies a member', async () => {
    const fx = await makeFixture('delete-guard');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    await expect(sprintsService.deleteSprint('nope', fx.ownerCtx)).rejects.toBeInstanceOf(
      SprintNotFoundError,
    );
    await expect(sprintsService.deleteSprint(sprint.id, fx.memberCtx)).rejects.toBeInstanceOf(
      NotSprintAdminError,
    );
  });
});

describe('assertSprintTransition (pure state machine)', () => {
  it('allows the two forward transitions', () => {
    expect(() => assertSprintTransition('planned', 'active')).not.toThrow();
    expect(() => assertSprintTransition('active', 'complete')).not.toThrow();
  });

  it('rejects every skip, reopen, and self-transition', () => {
    const illegal: Array<[SprintState, SprintState]> = [
      ['planned', 'complete'], // skip
      ['complete', 'active'], // reopen
      ['active', 'planned'], // reopen
      ['complete', 'planned'], // reopen
      ['planned', 'planned'], // self
      ['active', 'active'], // self
      ['complete', 'complete'], // self
    ];
    for (const [from, to] of illegal) {
      expect(() => assertSprintTransition(from, to)).toThrow(InvalidSprintTransitionError);
    }
  });

  it('is reachable via the service object too', () => {
    expect(() => sprintsService.assertSprintTransition('planned', 'active')).not.toThrow();
  });
});
