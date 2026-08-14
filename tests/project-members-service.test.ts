import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import {
  AlreadyProjectMemberError,
  InvalidAccessLevelError,
  InvalidProjectRoleError,
  LastProjectAdminError,
  NotAProjectMemberError,
  PermissionDeniedError,
  ProjectNotFoundError,
  TargetNotWorkspaceMemberError,
} from '@/lib/projects/errors';
import { RoleDefinitionNotFoundError } from '@/lib/permissions/errors';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Service-layer tests for projectMembersService (Story 6.4 · Subtask 6.4.4) —
// the project membership + access management write path. Real Postgres, no DB
// mocks, the truncate helper resets between tests (it CASCADEs workspace →
// project → project_membership). Typed-error assertions use the real classes.
//
// Authorization model under test:
//   * workspace owner/admin ALWAYS manage (no project membership needed);
//   * a project `admin` manages;
//   * a project `member`/`viewer` (or a plain workspace member with no project
//     row) cannot → PermissionDeniedError naming the key (MOTIR-2295; it was
//     NotProjectAdminError while this service ran its own private admin check);
//   * an actor who cannot BROWSE the project → ProjectNotFoundError (404), on
//     the reads as well as the writes.
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
  await adminDb.$disconnect();
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

    // DTO shape: userId / name / email / role / roleDefinition ONLY — never a
    // raw Prisma row. `roleDefinition` joined MOTIR-2485: it is what the member
    // row's chip reads, and `null` here IS the "built-in" answer.
    expect(Object.keys(member).sort()).toEqual([
      'email',
      'name',
      'role',
      'roleDefinition',
      'userId',
    ]);
    expect(member.userId).toBe(alice.id);
    expect(member.name).toBe('Alice');
    expect(member.email).toBe('alice-add@example.com');
    expect(member.role).toBe('viewer');
    expect(member.roleDefinition).toBeNull();

    const persisted = await withWorkspaceServiceContext(workspace.id, (tx) =>
      projectMembershipRepository.findByUserAndProject(alice.id, project.id, tx),
    );
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
    //
    // ⚠️ The refusal is now PermissionDeniedError, not NotProjectAdminError
    // (MOTIR-2295). The gate moved from this file's module-private admin check
    // to `projectAccessService.assertPermission`, which names the KEY it asked
    // for. Same HTTP status (403, via `projectMemberErrorResponse`); the `code`
    // goes from `NOT_PROJECT_ADMIN` to `PERMISSION_DENIED`, which no consumer of
    // these routes reads — `ProjectMembersSettings` special-cases only
    // `LAST_PROJECT_ADMIN`. The three places that DO read `NOT_PROJECT_ADMIN`
    // are on `project:administer`, which still throws it.
    const fresh = await addWorkspaceMember(workspace.id, 'fresh-authz@example.com');
    const refused = await projectMembersService
      .addMember({
        key,
        actorUserId: plain.id,
        ctx: ctxFor(plain.id, workspace.id),
        targetUserId: fresh.id,
        role: 'member',
      })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(PermissionDeniedError);
    expect((refused as PermissionDeniedError).permission).toBe('member:manage');

    // A project `member` (target, added above) also cannot manage — and the key
    // it is refused is `project:manage_access`, not `member:manage`: who is IN
    // the project and how open the project is are separate decisions.
    const refusedAccess = await projectMembersService
      .setAccessLevel({
        key,
        actorUserId: target.id,
        ctx: ctxFor(target.id, workspace.id),
        level: 'private',
      })
      .catch((e: unknown) => e);
    expect(refusedAccess).toBeInstanceOf(PermissionDeniedError);
    expect((refusedAccess as PermissionDeniedError).permission).toBe('project:manage_access');
  });

  it('setRole and removeMember are refused on member:manage too', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('authz-keys');
    const target = await addWorkspaceMember(workspace.id, 'target-keys@example.com', 'Target');
    const plain = await addWorkspaceMember(workspace.id, 'plain-keys@example.com', 'Plain');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: target.id,
      role: 'member',
    });
    const plainCtx = ctxFor(plain.id, workspace.id);

    for (const call of [
      () =>
        projectMembersService.setRole({
          key,
          actorUserId: plain.id,
          ctx: plainCtx,
          targetUserId: target.id,
          role: 'admin',
        }),
      () =>
        projectMembersService.removeMember({
          key,
          actorUserId: plain.id,
          ctx: plainCtx,
          targetUserId: target.id,
        }),
    ]) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect((err as PermissionDeniedError).permission).toBe('member:manage');
    }
  });

  it('the workspace owner still passes on EVERY access level — the always-pass rail survives', async () => {
    for (const level of ['open', 'limited', 'private'] as const) {
      const { workspace, key, owner, ownerCtx } = await makeFixture(`rail-${level}`);
      await projectMembersService.setAccessLevel({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        level,
      });
      const someone = await addWorkspaceMember(workspace.id, `rail-${level}@example.com`, 'Rail');
      const added = await projectMembersService.addMember({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: someone.id,
        role: 'member',
      });
      expect(added.role, `owner blocked on a ${level} project`).toBe('member');
      // …and the reads, which this card gated on `project:browse`.
      expect(
        (await projectMembersService.listMembers({ key, actorUserId: owner.id, ctx: ownerCtx }))
          .length,
      ).toBeGreaterThan(0);
      expect(
        (await projectMembersService.getAccess({ key, actorUserId: owner.id, ctx: ownerCtx }))
          .accessLevel,
      ).toBe(level);
    }
  });

  it('a NON-BROWSER gets 404, not 403 — a private project stays invisible', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('authz-404');
    await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });
    // Added AFTER the project went private, so no auto-seeded project membership.
    const outsider = await addWorkspaceMember(workspace.id, 'outsider-404@example.com', 'Out');
    const outsiderCtx = ctxFor(outsider.id, workspace.id);
    const target = await addWorkspaceMember(workspace.id, 'target-404@example.com', 'Target');

    // The WRITE — the private assert this replaced returned 403 here; a project
    // the actor cannot browse must be indistinguishable from a missing one.
    await expect(
      projectMembersService.addMember({
        key,
        actorUserId: outsider.id,
        ctx: outsiderCtx,
        targetUserId: target.id,
        role: 'member',
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    // The READS — ungated before this card, so a workspace member who could not
    // browse a private project could still read its member list and its access
    // level. That hole is closed.
    await expect(
      projectMembersService.listMembers({ key, actorUserId: outsider.id, ctx: outsiderCtx }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      projectMembersService.getAccess({ key, actorUserId: outsider.id, ctx: outsiderCtx }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
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

// ── Assigning a CUSTOM role (Story MOTIR-2257 · Subtask MOTIR-2485) ─────────
//
// `setRole` is the ONE single-member assignment path, and after this card it
// takes a `RoleDTO.key`: a built-in's enum value, or a role definition's id. What
// these tests are really guarding is the PAIRED-COLUMN invariant — `role` is a
// tier and `role_definition_id` is the pointer, and a membership that carries one
// without the other is a member whose screens and whose permissions disagree.
describe('setRole — custom roles', () => {
  it('assigns a custom role: the DTO names it, and the pointer + tier are written TOGETHER', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('custom-assign');
    const dana = await addWorkspaceMember(workspace.id, 'dana-assign@example.com', 'Dana');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: dana.id,
      role: 'viewer',
    });
    const role = await projectRoleDefinitionService.create({
      projectId: project.id,
      ctx: ownerCtx,
      name: 'Contractor',
      permissions: ['work_item:edit'],
    });

    const updated = await projectMembersService.setRole({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: dana.id,
      role: role.id,
    });

    expect(updated.roleDefinition).toEqual({ id: role.id, name: 'Contractor' });
    // The tier moved to CUSTOM_ROLE_TIER in the SAME write — a membership left on
    // `viewer` with a pointer would resolve one way and read another.
    expect(updated.role).toBe('member');

    // ⚠️ SURVIVES A RELOAD, READ BACK THROUGH THE DTO — not through the database.
    // The row is what the members screen renders, so the screen's own read is the
    // one that has to carry the role's name.
    const listed = await projectMembersService.listMembers({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
    });
    expect(listed.find((m) => m.userId === dana.id)?.roleDefinition).toEqual({
      id: role.id,
      name: 'Contractor',
    });
  });

  it('assigning a BUILT-IN to a custom-role holder CLEARS the pointer and sets the tier', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('custom-clear');
    const eli = await addWorkspaceMember(workspace.id, 'eli-clear@example.com', 'Eli');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: eli.id,
      role: 'member',
    });
    const role = await projectRoleDefinitionService.create({
      projectId: project.id,
      ctx: ownerCtx,
      name: 'Contractor',
      permissions: ['work_item:edit'],
    });
    await projectMembersService.setRole({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: eli.id,
      role: role.id,
    });

    const back = await projectMembersService.setRole({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: eli.id,
      role: 'viewer',
    });

    expect(back.role).toBe('viewer');
    expect(back.roleDefinition).toBeNull();
    // No membership is ever left pointing at a role it does not hold.
    const persisted = await withWorkspaceServiceContext(workspace.id, (tx) =>
      projectMembershipRepository.findByUserAndProject(eli.id, project.id, tx),
    );
    expect(persisted?.roleDefinitionId).toBeNull();
    expect(persisted?.role).toBe('viewer');
  });

  it('THE ASSIGNMENT BITES: a role that withholds sprint:manage resolves without it', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('custom-bites');
    const fay = await addWorkspaceMember(workspace.id, 'fay-bites@example.com', 'Fay');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: fay.id,
      // A `member` HOLDS sprint:manage — so the absence below is the role's
      // doing, not the tier's.
      role: 'member',
    });
    const before = await projectAccessService.getPermissions(
      project.id,
      ctxFor(fay.id, workspace.id),
    );
    expect(before.has('sprint:manage')).toBe(true);

    const role = await projectRoleDefinitionService.create({
      projectId: project.id,
      ctx: ownerCtx,
      name: 'No sprints',
      permissions: ['work_item:edit', 'project:browse'],
    });
    await projectMembersService.setRole({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: fay.id,
      role: role.id,
    });

    // The read-back through the RESOLUTION is what proves the seam: the write
    // reached the column the policy reads, not merely a column.
    const after = await projectAccessService.getPermissions(
      project.id,
      ctxFor(fay.id, workspace.id),
    );
    expect(after.has('sprint:manage')).toBe(false);
    expect(after.has('work_item:edit')).toBe(true);
  });

  it('a role definition from ANOTHER project in the same workspace is refused with 404, before any write', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('custom-sibling');
    const other = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Other project',
    });
    const foreign = await projectRoleDefinitionService.create({
      projectId: other.id,
      ctx: ownerCtx,
      name: 'Contractor',
      permissions: ['work_item:edit'],
    });
    const gus = await addWorkspaceMember(workspace.id, 'gus-sibling@example.com', 'Gus');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: gus.id,
      role: 'viewer',
    });

    await expect(
      projectMembersService.setRole({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: gus.id,
        role: foreign.id,
      }),
    ).rejects.toBeInstanceOf(RoleDefinitionNotFoundError);

    // BEFORE any write — the membership is untouched, tier and pointer both.
    const listed = await projectMembersService.listMembers({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
    });
    const row = listed.find((m) => m.userId === gus.id);
    expect(row?.role).toBe('viewer');
    expect(row?.roleDefinition).toBeNull();
  });

  it('a role definition from ANOTHER WORKSPACE is refused with the same 404 — no existence leak', async () => {
    const mine = await makeFixture('custom-mine');
    const theirs = await makeFixture('custom-theirs');
    const foreign = await projectRoleDefinitionService.create({
      projectId: theirs.project.id,
      ctx: theirs.ownerCtx,
      name: 'Contractor',
      permissions: ['work_item:edit'],
    });
    const hal = await addWorkspaceMember(mine.workspace.id, 'hal-foreign@example.com', 'Hal');
    await projectMembersService.addMember({
      key: mine.key,
      actorUserId: mine.owner.id,
      ctx: mine.ownerCtx,
      targetUserId: hal.id,
      role: 'viewer',
    });

    // Driven under MY workspace context, naming THEIR role. The refusal must be
    // indistinguishable from an id that never existed.
    await expect(
      projectMembersService.setRole({
        key: mine.key,
        actorUserId: mine.owner.id,
        ctx: mine.ownerCtx,
        targetUserId: hal.id,
        role: foreign.id,
      }),
    ).rejects.toBeInstanceOf(RoleDefinitionNotFoundError);
    await expect(
      projectMembersService.setRole({
        key: mine.key,
        actorUserId: mine.owner.id,
        ctx: mine.ownerCtx,
        targetUserId: hal.id,
        role: 'role-that-never-existed',
      }),
    ).rejects.toBeInstanceOf(RoleDefinitionNotFoundError);
  });

  it('`owner` stays a 400, not a 404 — a misused enum member is not a missing object', async () => {
    const { workspace, key, owner, ownerCtx } = await makeFixture('custom-owner');
    const ivy = await addWorkspaceMember(workspace.id, 'ivy-owner@example.com', 'Ivy');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: ivy.id,
      role: 'viewer',
    });
    await expect(
      projectMembersService.setRole({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: ivy.id,
        role: 'owner',
      }),
    ).rejects.toBeInstanceOf(InvalidProjectRoleError);
  });

  it('the LAST-ADMIN guard trips when the only admin is moved onto a custom role', async () => {
    const { workspace, key, owner, ownerCtx, project } = await makeFixture('custom-lastadmin');
    const jo = await addWorkspaceMember(workspace.id, 'jo-lastadmin@example.com', 'Jo');
    await projectMembersService.addMember({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: jo.id,
      role: 'admin',
    });
    const role = await projectRoleDefinitionService.create({
      projectId: project.id,
      ctx: ownerCtx,
      name: 'Contractor',
      permissions: ['work_item:edit'],
    });

    // A custom role sits at CUSTOM_ROLE_TIER, so this IS a demotion — the guard
    // reads the resolved tier, not the requested key.
    await expect(
      projectMembersService.setRole({
        key,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: jo.id,
        role: role.id,
      }),
    ).rejects.toBeInstanceOf(LastProjectAdminError);
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
    const gone = await withWorkspaceServiceContext(workspace.id, (tx) =>
      projectMembershipRepository.findByUserAndProject(frank.id, project.id, tx),
    );
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
    const count = await adminDb.projectMembership.count({ where: { projectId: project.id } });
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

    const persistedProject = await adminDb.project.findUnique({ where: { id: project.id } });
    expect(persistedProject?.accessLevel).toBe('private');

    // Workspace has owner + m1 + m2 = 3 members → 3 project memberships.
    const rows = await adminDb.projectMembership.findMany({ where: { projectId: project.id } });
    expect(rows).toHaveLength(3);
    const byUser = new Map(rows.map((r) => [r.userId, r.role]));
    expect(byUser.get(owner.id)).toBe('member'); // seeded
    expect(byUser.get(m1.id)).toBe('admin'); // preserved, NOT downgraded
    expect(byUser.get(m2.id)).toBe('member'); // seeded
  });
});

describe('getAccess', () => {
  it('reads the project default access level (open)', async () => {
    const { key, owner, ownerCtx } = await makeFixture('get-access-default');
    const access = await projectMembersService.getAccess({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
    });
    expect(access).toEqual({ key, accessLevel: 'open' });
  });

  it('reflects a level set via setAccessLevel', async () => {
    const { key, owner, ownerCtx } = await makeFixture('get-access-private');
    await projectMembersService.setAccessLevel({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });
    const access = await projectMembersService.getAccess({
      key,
      actorUserId: owner.id,
      ctx: ownerCtx,
    });
    expect(access.accessLevel).toBe('private');
  });

  it('404s on an unknown project key (no existence leak)', async () => {
    const { owner, ownerCtx } = await makeFixture('get-access-missing');
    await expect(
      projectMembersService.getAccess({ key: 'NOPE', actorUserId: owner.id, ctx: ownerCtx }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
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
