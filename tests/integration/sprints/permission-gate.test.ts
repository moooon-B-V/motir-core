import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { NotSprintAdminError } from '@/lib/sprints/errors';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { createTestProject } from '../../fixtures/projectFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// The `sprint:manage` GATE (Story MOTIR-2291 · Subtask MOTIR-2350), against real
// Postgres through the real resolution — never a mocked `hasPermission`, because
// what is being proved is which ACTORS the policy admits, and a mock would only
// prove the call site passes the string it was given.
//
// The story's two halves move in OPPOSITE directions and both are asserted here:
//
//   * `sprintsService`'s five lifecycle writes were gated to the workspace
//     OWNER/ADMIN by a module-private `isOwnerRole` check. `sprint:manage`
//     LOOSENS them — a project ADMIN who is only a workspace member, and a
//     project MEMBER, can now run their own sprint. That widening is the kind a
//     test must state out loud (`notes.html` #219's sibling lesson: a widening no
//     test proves is a widening nobody reviewed).
//   * `backlogService` had NO project gate at all, so ranking and sprint
//     assignment TIGHTEN: a project `viewer` could re-order somebody else's
//     backlog and is now refused.
//
// And the line the inventory did not draw: the three READS stay at
// `project:browse`, so a viewer who can see the board can still see the backlog.

const PASSWORD = 'hunter2hunter2';

interface Fixture {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** Workspace OWNER — passes via the always-pass rail, whatever their project role. */
  ownerCtx: ServiceContext;
  /** Project ADMIN, workspace member — REFUSED before this card, admitted after. */
  projectAdminCtx: ServiceContext;
  /** Project MEMBER, workspace member — REFUSED before this card, admitted after. */
  projectMemberCtx: ServiceContext;
  /** Project VIEWER — admitted to the grooming writes before this card, refused after. */
  viewerCtx: ServiceContext;
  /** Workspace member holding NO project membership — the implicit grant. */
  outsiderCtx: ServiceContext;
}

let seq = 0;

async function makeFixture(label: string): Promise<Fixture> {
  seq += 1;
  const owner = await usersService.createUser({
    email: `gate-owner-${label}-${seq}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Gate WS ${label} ${seq}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });
  const ownerCtx: ServiceContext = { userId: owner.id, workspaceId };

  async function actor(role: 'admin' | 'member' | 'viewer' | null): Promise<ServiceContext> {
    const u = await usersService.createUser({
      email: `gate-${role ?? 'outsider'}-${label}-${seq}@example.com`,
      password: PASSWORD,
      name: role ?? 'outsider',
    });
    await db.workspaceMembership.create({ data: { userId: u.id, workspaceId, role: 'member' } });
    if (role) {
      await projectMembersService.addMember({
        key: project.identifier,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: u.id,
        role,
      });
    }
    return { userId: u.id, workspaceId };
  }

  return {
    workspaceId,
    projectId: project.id,
    projectKey: project.identifier,
    ownerCtx,
    projectAdminCtx: await actor('admin'),
    projectMemberCtx: await actor('member'),
    viewerCtx: await actor('viewer'),
    outsiderCtx: await actor(null),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('the sprint LIFECYCLE — sprint:manage, a deliberate WIDENING', () => {
  it('admits a project ADMIN who is only a workspace member (refused before this card)', async () => {
    const fx = await makeFixture('life-admin');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.projectAdminCtx);
    expect(sprint.state).toBe('planned');
    // …and can carry it through the rest of the lifecycle.
    await sprintsService.updateSprint(sprint.id, { name: 'Renamed' }, fx.projectAdminCtx);
    const started = await sprintsService.startSprint(sprint.id, {}, fx.projectAdminCtx);
    expect(started.state).toBe('active');
  });

  it('a MEMBER can START one — the board it provisions must not need board:configure', async () => {
    // ⚠️ THE REGRESSION THIS CARD INTRODUCED AND ITS E2E CAUGHT. `startSprint`
    // provisions the scrum board the sprint is viewed on. That went through
    // `boardsService.createBoard`, which asserts `board:configure` — ADMIN-only.
    // While starting a sprint was workspace-OWNER-only the inner assert always
    // passed and the coupling was invisible; `sprint:manage` admits a MEMBER, who
    // does not hold `board:configure`, so the inner call refused them and the
    // route had no arm for it — a 500 on the most ordinary sprint action there is.
    //
    // Pinned here as well as in the E2E because this is the tier that runs on
    // every push, and a 500 is exactly the failure a service test can catch first.
    const fx = await makeFixture('life-board');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.projectMemberCtx);
    const started = await sprintsService.startSprint(sprint.id, {}, fx.projectMemberCtx);
    expect(started.state).toBe('active');
    // …and the board really was provisioned, by an actor who may not configure one.
    const boards = await db.board.findMany({ where: { projectId: fx.projectId } });
    expect(boards.some((b) => b.type === 'scrum')).toBe(true);
  });

  it('admits a project MEMBER — the team that runs the sprint can run the sprint', async () => {
    const fx = await makeFixture('life-member');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.projectMemberCtx);
    await expect(
      sprintsService.deleteSprint(sprint.id, fx.projectMemberCtx),
    ).resolves.toBeUndefined();
  });

  it('refuses a project VIEWER, keeping the shipped NOT_SPRINT_ADMIN code', async () => {
    const fx = await makeFixture('life-viewer');
    // The code is a documented v1-API contract error, so the 403's SHAPE is
    // unchanged by this card — only the actor set behind it moved.
    await expect(
      sprintsService.createSprint(fx.projectId, {}, fx.viewerCtx),
    ).rejects.toBeInstanceOf(NotSprintAdminError);
  });

  it('refuses a workspace member holding NO project membership', async () => {
    // This actor resolves through IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS rather
    // than a role, which is the case a role-set test cannot reach.
    const fx = await makeFixture('life-outsider');
    await expect(
      sprintsService.createSprint(fx.projectId, {}, fx.outsiderCtx),
    ).rejects.toBeInstanceOf(NotSprintAdminError);
  });

  it('still admits the workspace owner, via the always-pass rail', async () => {
    const fx = await makeFixture('life-owner');
    await expect(sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx)).resolves.toBeTruthy();
  });
});

describe('backlog GROOMING — sprint:manage, a TIGHTENING', () => {
  /** A backlog issue authored by the owner — the row the grooming writes act on. */
  async function itemFor(fx: Fixture): Promise<string> {
    const item = await backlogService.createBacklogIssue(
      fx.projectId,
      { title: 'Groomable', kind: 'task' },
      fx.ownerCtx,
    );
    return item.id;
  }

  it('refuses a project VIEWER re-ranking the backlog — the hole this card closes', async () => {
    const fx = await makeFixture('groom-rank');
    const itemId = await itemFor(fx);
    await expect(backlogService.rankIssue(itemId, {}, fx.viewerCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('refuses a VIEWER moving an item into a sprint, and in bulk', async () => {
    const fx = await makeFixture('groom-assign');
    const itemId = await itemFor(fx);
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    await expect(
      backlogService.assignToSprint(itemId, sprint.id, undefined, fx.viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      backlogService.bulkAssignToSprint([itemId], sprint.id, fx.viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(backlogService.bulkMoveToBacklog([itemId], fx.viewerCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    // and nothing was written by the refused calls
    const after = await db.workItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(after.sprintId).toBeNull();
  });

  it('refuses a workspace member with no project membership (the implicit grant)', async () => {
    const fx = await makeFixture('groom-outsider');
    const itemId = await itemFor(fx);
    await expect(backlogService.rankIssue(itemId, {}, fx.outsiderCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('still admits a project MEMBER — grooming is everyday work, not administration', async () => {
    const fx = await makeFixture('groom-member');
    const itemId = await itemFor(fx);
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    const moved = await backlogService.assignToSprint(
      itemId,
      sprint.id,
      undefined,
      fx.projectMemberCtx,
    );
    expect(moved.sprintId).toBe(sprint.id);
    await expect(backlogService.moveToBacklog(itemId, fx.projectMemberCtx)).resolves.toBeTruthy();
  });
});

describe('the READS stay at project:browse, and creating stays at work_item:edit', () => {
  it('lets a VIEWER read the backlog and a sprint’s issues', async () => {
    const fx = await makeFixture('read-viewer');
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ownerCtx);
    await expect(backlogService.getBacklog(fx.projectId, {}, fx.viewerCtx)).resolves.toBeTruthy();
    await expect(backlogService.getSprintIssues(sprint.id, {}, fx.viewerCtx)).resolves.toBeTruthy();
    await expect(sprintsService.listByProject(fx.projectId, fx.viewerCtx)).resolves.toBeTruthy();
  });

  it('refuses a VIEWER creating an issue into the backlog — work_item:edit, not sprint:manage', async () => {
    const fx = await makeFixture('read-create');
    await expect(
      backlogService.createBacklogIssue(
        fx.projectId,
        { title: 'Nope', kind: 'task' },
        fx.viewerCtx,
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('404s a project in another workspace before any permission is tested', async () => {
    // The no-existence-leak ordering, inherited from the shared gate: a foreign
    // project must be indistinguishable from one that never existed.
    const mine = await makeFixture('leak-mine');
    const theirs = await makeFixture('leak-theirs');
    await expect(
      backlogService.getBacklog(theirs.projectId, {}, mine.ownerCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
