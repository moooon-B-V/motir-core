import { db } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';

// Seed for the Roles & permissions E2E (Story MOTIR-2282 · Subtask MOTIR-2265).
//
// ⚠️ THE HEADCOUNTS ARE DELIBERATELY DISTINCT — 1 admin, 3 members, 2 viewers.
// The list row draws a member count per role, and it is the one number on the
// screen that comes from a different table. Seeding the same count at every role
// would let a placeholder, an off-by-one or a count of the wrong role pass; three
// different numbers make the assertion mean "the right number", not "a number".
//
// A `private` project is used so a NO-ACCESS actor genuinely exists: on an open
// project every workspace member can browse, and the story's no-access step would
// be unfalsifiable.

export const ROLES_E2E_PASSWORD = 'roles-permissions-e2e-pass-7';

/** How many project memberships each built-in role gets. Distinct on purpose. */
export const ROLE_HEADCOUNT = { admin: 1, member: 3, viewer: 2 } as const;

export interface RolesPermissionsSeed {
  adminEmail: string;
  memberEmail: string;
  viewerEmail: string;
  /** In the workspace, on NO project — the no-access actor. */
  outsiderEmail: string;
  password: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
}

export async function seedRolesPermissions(prefix: string): Promise<RolesPermissionsSeed> {
  const owner = await usersService.createUser({
    email: `${prefix}-owner@example.com`,
    password: ROLES_E2E_PASSWORD,
    name: 'Roles Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Roles E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Roles E2E Project',
    identifier: 'RLE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };

  // `private` FIRST: going private auto-enrols the workspace members that exist
  // at that moment, and right now that is only the owner. Everyone below is
  // created after, so their membership is exactly the role we give them.
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    level: 'private',
  });

  async function member(name: string, role: 'admin' | 'member' | 'viewer') {
    const user = await usersService.createUser({
      email: `${prefix}-${name}@example.com`,
      password: ROLES_E2E_PASSWORD,
      name,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: user.id,
      role,
    });
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
    return user;
  }

  // ⚠️ GO-PRIVATE ENROLS THE OWNER AS A `member`, NOT AN `admin`
  // (`projectMembersService.setAccessLevel` — *"seeds every current workspace
  // member as a project `member`"*), so the owner is PROMOTED here explicitly.
  // Without this the counts are admin 0 / member 4, and the spec's headcount
  // assertions would be checking a fixture nobody meant to build. The promotion
  // goes through the shipped service rather than a DB poke, so the membership it
  // produces is the same row the product would produce.
  await projectMembersService.setRole({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    targetUserId: owner.id,
    role: 'admin',
  });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  const members = await Promise.all(
    Array.from({ length: ROLE_HEADCOUNT.member }, (_, i) => member(`member${i + 1}`, 'member')),
  );
  const viewers = await Promise.all(
    Array.from({ length: ROLE_HEADCOUNT.viewer }, (_, i) => member(`viewer${i + 1}`, 'viewer')),
  );

  // The NO-ACCESS actor: a real workspace member with no project membership. On
  // a private project they cannot browse, so both routes must answer with the
  // shipped no-access panel rather than a crash or an empty shell.
  const outsider = await usersService.createUser({
    email: `${prefix}-outsider@example.com`,
    password: ROLES_E2E_PASSWORD,
    name: 'Outsider',
  });
  await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });
  await db.workspaceMembership.update({
    where: { userId_workspaceId: { userId: outsider.id, workspaceId: workspace.id } },
    data: { activeProjectId: project.id },
  });

  // Assert the seed produced the counts the spec asserts against, HERE — a
  // silently mis-seeded fixture would turn the spec's headcount check into a
  // test of the fixture rather than of the page.
  const counts = await db.projectMembership.groupBy({
    by: ['role'],
    where: { projectId: project.id },
    _count: { _all: true },
  });
  const actual = Object.fromEntries(counts.map((row) => [row.role, row._count._all]));
  for (const [role, expected] of Object.entries(ROLE_HEADCOUNT)) {
    if (actual[role] !== expected) {
      throw new Error(
        `roles-permissions-seed: expected ${expected} ${role} membership(s), got ${actual[role] ?? 0}`,
      );
    }
  }

  return {
    adminEmail: `${prefix}-owner@example.com`,
    memberEmail: members[0]!.email,
    viewerEmail: viewers[0]!.email,
    outsiderEmail: outsider.email,
    password: ROLES_E2E_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
  };
}
