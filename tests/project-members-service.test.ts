import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import {
  AlreadyProjectMemberError,
  InvalidAccessLevelError,
  InvalidProjectRoleError,
  LastProjectAdminError,
  NotAProjectMemberError,
  NotProjectAdminError,
  ProjectNotFoundError,
  TargetNotWorkspaceMemberError,
} from '@/lib/projects/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from './helpers/db';

// Service-layer tests for projectMembersService (Story 6.4 · Subtask 6.4.4) —
// the project membership + access management write path. Real Postgres, no DB
// mocks, the truncate helper resets between tests (it CASCADEs workspace →
// project → project_membership). Typed-error assertions use the real classes.
//
// Authorization model under test:
//   * workspace owner/admin ALWAYS manage (no project membership needed);
//   * a project `admin` manages;
//   * a project `member`/`viewer` (or a plain workspace member with no project
//     row) cannot → NotProjectAdminError.
//
// Coverage: add (happy + role validation + target-must-be-workspace-member +
// duplicate), the authorization matrix, set-role (+ last-admin guard +
// not-a-member), remove (+ last-admin guard + idempotent-404), set-access-level
// (open/limited/private + go-private member seeding + invalid level), list, and
// the no-existence-leak 404 on an unknown key.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: PASSWORD, name });
}

// An owner + workspace + project. The owner is the workspace OWNER (createWorkspace
// seeds the founder as `owner`), so they manage projects via the workspace-manager
// tier without any project membership row.
async function makeFixture(slug: string) {
  const owner = await makeUser(`owner-${slug}@example.com`, 'Owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ctx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  return { owner, workspace, project, key: project.identifier, ownerCtx: ctx };
}

// Add a brand-new user to the workspace as a plain `member`, returning the user.
async function addWorkspaceMember(workspaceId: string, email: string, name = 'Member') {
  const user = await makeUser(email, name);
  await workspacesService.addMember({ userId: user.id, workspaceId, role: 'member' });
  return user;
}

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

describe('addMember', () => {
  it('a workspace owner adds a workspace member with a project role and gets a DTO', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('add');
    const alice = await addWorkspaceMember(workspace.id, 'alice-add@example.com', 'Alice');

    const member = await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: alice.id,
      role: 'viewer',
    });

    // DTO shape: userId / name / email / role ONLY — never a raw Prisma row.
    expect(Object.keys(member).sort()).toEqual(['email', 'name', 'role', 'userId']);
    expect(member.userId).toBe(alice.id);
    expect(member.name).toBe('Alice');
    expect(member.email).toBe('alice-add@example.com');
    expect(member.role).toBe('viewer');

    const persisted = await projectMembershipRepository.findByUserAndProject(alice.id, project.id);
    expect(persisted?.role).toBe('viewer');
    expect(persisted?.workspaceId).toBe(workspace.id);
  });

  it('rejects an invalid role with InvalidProjectRoleError (owner is not project-assignable)', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('role');
    const bob = await addWorkspaceMember(workspace.id, 'bob-role@example.com');
    await expect(
      projectMembersService.addMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: bob.id,
        role: 'owner',
      }),
    ).rejects.toBeInstanceOf(InvalidProjectRoleError);
  });

  it('rejects a target who is not a workspace member', async () => {
    const { key, owner, ownerCtx } = await makeFixture('target');
    const outsider = await makeUser('outsider@example.com');
    await expect(
      projectMembersService.addMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: outsider.id,
        role: 'member',
      }),
    ).rejects.toBeInstanceOf(TargetNotWorkspaceMemberError);
  });

  it('rejects a duplicate add with AlreadyProjectMemberError', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('dup');
    const carol = await addWorkspaceMember(workspace.id, 'carol-dup@example.com');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: carol.id,
      role: 'member',
    });
    await expect(
      projectMembersService.addMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: carol.id,
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(AlreadyProjectMemberError);
  });

  it('404s on an unknown project key (no existence leak)', async () => {
    const { owner, ownerCtx, workspace } = await makeFixture('miss');
    const dave = await addWorkspaceMember(workspace.id, 'dave-miss@example.com');
    await expect(
      projectMembersService.addMember({
        key: 'NOPE',
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: dave.id,
        role: 'member',
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('authorization — who may manage', () => {
  it('a project admin can manage; a project member/viewer cannot', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('authz');
    const admin = await addWorkspaceMember(workspace.id, 'admin-authz@example.com', 'Adminy');
    const plain = await addWorkspaceMember(workspace.id, 'plain-authz@example.com', 'Plain');
    const target = await addWorkspaceMember(workspace.id, 'target-authz@example.com', 'Target');

    // Owner promotes `admin` to project admin.
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: admin.id,
      role: 'admin',
    });

    // The project admin can add a member.
    const added = await projectMembersService.addMember({
      key,
      actorUserId: admin.id,
      ctx: ctxFor(admin.id, workspace.id),
      targetUserId: target.id,
      role: 'member',
    });
    expect(added.role).toBe('member');

    // A plain workspace member (no project admin row) cannot manage.
    const fresh = await addWorkspaceMember(workspace.id, 'fresh-authz@example.com');
    await expect(
      projectMembersService.addMember({
        key,
        actorUserId: plain.id,
        ctx: ctxFor(plain.id, workspace.id),
        targetUserId: fresh.id,
        role: 'member',
      }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);

    // A project `member` (target, added above) also cannot manage.
    await expect(
      projectMembersService.setAccessLevel({
        key,
        actorUserId: target.id,
        ctx: ctxFor(target.id, workspace.id),
        level: 'private',
      }),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
  });
});

describe('setRole', () => {
  it('changes a role and returns the updated DTO', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('setrole');
    const eve = await addWorkspaceMember(workspace.id, 'eve-setrole@example.com', 'Eve');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: eve.id,
      role: 'viewer',
    });
    const updated = await projectMembersService.setRole({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: eve.id,
      role: 'member',
    });
    expect(updated.role).toBe('member');
  });

  it('404s (NotAProjectMember) when the target has no membership', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('setrole-miss');
    const ghost = await addWorkspaceMember(workspace.id, 'ghost-setrole@example.com');
    await expect(
      projectMembersService.setRole({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: ghost.id,
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(NotAProjectMemberError);
  });

  it('blocks demoting the last admin (LastProjectAdminError) but allows it once a second admin exists', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('lastadmin');
    const a = await addWorkspaceMember(workspace.id, 'a-lastadmin@example.com');
    const b = await addWorkspaceMember(workspace.id, 'b-lastadmin@example.com');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: a.id,
      role: 'admin',
    });

    // `a` is the only project admin → demoting blocked.
    await expect(
      projectMembersService.setRole({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: a.id,
        role: 'member',
      }),
    ).rejects.toBeInstanceOf(LastProjectAdminError);

    // Add a second admin, then the demotion is allowed.
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: b.id,
      role: 'admin',
    });
    const demoted = await projectMembersService.setRole({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: a.id,
      role: 'member',
    });
    expect(demoted.role).toBe('member');
  });
});

describe('removeMember', () => {
  it('removes a member and returns the removed DTO', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('remove');
    const frank = await addWorkspaceMember(workspace.id, 'frank-remove@example.com', 'Frank');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: frank.id,
      role: 'member',
    });
    const removed = await projectMembersService.removeMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: frank.id,
    });
    expect(removed.userId).toBe(frank.id);
    const gone = await projectMembershipRepository.findByUserAndProject(frank.id, project.id);
    expect(gone).toBeNull();
  });

  it('404s (NotAProjectMember) when removing a non-member', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('remove-miss');
    const nobody = await addWorkspaceMember(workspace.id, 'nobody-remove@example.com');
    await expect(
      projectMembersService.removeMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: nobody.id,
      }),
    ).rejects.toBeInstanceOf(NotAProjectMemberError);
  });

  it('blocks removing the last admin', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('remove-lastadmin');
    const sole = await addWorkspaceMember(workspace.id, 'sole-remove@example.com');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: sole.id,
      role: 'admin',
    });
    await expect(
      projectMembersService.removeMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: sole.id,
      }),
    ).rejects.toBeInstanceOf(LastProjectAdminError);
  });
});

describe('setAccessLevel', () => {
  it('sets open / limited without seeding members', async () => {
    const { key, owner, ownerCtx, project } = await makeFixture('access-open');
    const res = await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'limited',
    });
    expect(res).toEqual({ key, accessLevel: 'limited' });
    const count = await db.projectMembership.count({ where: { projectId: project.id } });
    expect(count).toBe(0);
  });

  it('rejects an invalid access level', async () => {
    const { key, owner, ownerCtx } = await makeFixture('access-bad');
    await expect(
      projectMembersService.setAccessLevel({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        level: 'secret',
      }),
    ).rejects.toBeInstanceOf(InvalidAccessLevelError);
  });

  it('going private seeds every current workspace member as a project member, preserving existing roles', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('access-private');
    const m1 = await addWorkspaceMember(workspace.id, 'm1-private@example.com');
    const m2 = await addWorkspaceMember(workspace.id, 'm2-private@example.com');
    // Pre-add m1 as an admin — go-private must NOT downgrade them.
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: m1.id,
      role: 'admin',
    });

    const res = await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });
    expect(res.accessLevel).toBe('private');

    const persistedProject = await db.project.findUnique({ where: { id: project.id } });
    expect(persistedProject?.accessLevel).toBe('private');

    // Workspace has owner + m1 + m2 = 3 members → 3 project memberships.
    const rows = await db.projectMembership.findMany({ where: { projectId: project.id } });
    expect(rows).toHaveLength(3);
    const byUser = new Map(rows.map((r) => [r.userId, r.role]));
    expect(byUser.get(owner.id)).toBe('member'); // seeded
    expect(byUser.get(m1.id)).toBe('admin'); // preserved, NOT downgraded
    expect(byUser.get(m2.id)).toBe('member'); // seeded
  });
});

describe('listMembers', () => {
  it('lists members ordered by createdAt asc', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('list');
    const first = await addWorkspaceMember(workspace.id, 'first-list@example.com', 'First');
    const second = await addWorkspaceMember(workspace.id, 'second-list@example.com', 'Second');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: first.id,
      role: 'member',
    });
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: second.id,
      role: 'viewer',
    });
    const members = await projectMembersService.listMembers({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
    });
    expect(members.map((m) => m.userId)).toEqual([first.id, second.id]);
    expect(members.map((m) => m.role)).toEqual(['member', 'viewer']);
  });
});
