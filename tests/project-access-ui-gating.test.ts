import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { assignableMembersService } from '@/lib/services/assignableMembersService';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from './helpers/db';

// Service-layer tests for the Story 6.4 · Subtask 6.4.6 UI-gating BACKING
// behaviour — the two server-side decisions the UI renders:
//   (1) `projectsService.listProjects` returns only projects the actor may
//       BROWSE, so the switcher / nav never lists a private project the actor
//       isn't on (no shown-then-denied).
//   (2) `assignableMembersService.list` scopes assignable users by access level:
//       a `private` project → only its project members; `open` / `limited` → the
//       whole workspace.
// Real Postgres, no DB mocks (mirrors project-access-service.test.ts).

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

describe('listProjects — browsable-only filter (6.4.6)', () => {
  it('hides a private project from a non-member while keeping the open one', async () => {
    const owner = await makeUser('owner-lp@ex.com', 'Owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'WS',
      ownerUserId: owner.id,
    });
    const ownerCtx = ctxFor(owner.id, workspace.id);

    const openProject = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Open Project',
    });
    const privateProject = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Private Project',
    });
    await projectMembersService.setAccessLevel({
      key: privateProject.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });

    // A plain workspace member added AFTER the project went private — so they
    // were NOT auto-seeded as a member of it.
    const plain = await makeUser('plain-lp@ex.com', 'Plain');
    await workspacesService.addMember({ userId: plain.id, workspaceId: workspace.id });

    const ownerList = await projectsService.listProjects(workspace.id, owner.id);
    const plainList = await projectsService.listProjects(workspace.id, plain.id);

    // Owner (workspace owner) browses everything; the plain member sees only the
    // open project — the private one is filtered out.
    expect(ownerList.map((p) => p.id).sort()).toEqual([openProject.id, privateProject.id].sort());
    expect(plainList.map((p) => p.id)).toEqual([openProject.id]);
    // The DTO now carries the access level the UI branches on.
    expect(ownerList.find((p) => p.id === privateProject.id)?.accessLevel).toBe('private');
  });

  it('shows a private project once the actor is added as a project member', async () => {
    const owner = await makeUser('owner-lp2@ex.com', 'Owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'WS2',
      ownerUserId: owner.id,
    });
    const ownerCtx = ctxFor(owner.id, workspace.id);
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Secret',
    });
    await projectMembersService.setAccessLevel({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });
    const member = await makeUser('member-lp2@ex.com', 'Member');
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    expect(await projectsService.listProjects(workspace.id, member.id)).toEqual([]);

    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: member.id,
      role: 'viewer',
    });

    const after = await projectsService.listProjects(workspace.id, member.id);
    expect(after.map((p) => p.id)).toEqual([project.id]);
  });
});

describe('assignableMembersService.list — access-scoped pickers (6.4.6)', () => {
  it('lists the whole workspace on an open project, only project members on a private one', async () => {
    const owner = await makeUser('owner-am@ex.com', 'Owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: 'WS3',
      ownerUserId: owner.id,
    });
    const ownerCtx = ctxFor(owner.id, workspace.id);
    const openProject = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Open',
    });
    const privateProject = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Private',
    });

    // `onProject` joins the workspace BEFORE the private project is sealed, so
    // go-private auto-seeds them as a member of it.
    const onProject = await makeUser('onproj-am@ex.com', 'OnProject');
    await workspacesService.addMember({ userId: onProject.id, workspaceId: workspace.id });
    await projectMembersService.setAccessLevel({
      key: privateProject.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });

    // `offProject` joins the workspace AFTER the seal, so they are a workspace
    // member but NOT a member of the private project.
    const offProject = await makeUser('offproj-am@ex.com', 'OffProject');
    await workspacesService.addMember({ userId: offProject.id, workspaceId: workspace.id });

    // OPEN → every workspace member is assignable.
    const openMembers = await assignableMembersService.list({
      projectId: openProject.id,
      accessLevel: 'open',
      ctx: ownerCtx,
    });
    expect(openMembers.map((m) => m.userId).sort()).toEqual(
      [owner.id, onProject.id, offProject.id].sort(),
    );

    // PRIVATE → only the project's members (owner + onProject, auto-seeded on
    // go-private), NOT the off-project workspace member.
    const privateMembers = await assignableMembersService.list({
      projectId: privateProject.id,
      accessLevel: 'private',
      ctx: ownerCtx,
    });
    const ids = privateMembers.map((m) => m.userId).sort();
    expect(ids).toContain(owner.id);
    expect(ids).toContain(onProject.id);
    expect(ids).not.toContain(offProject.id);
  });
});
