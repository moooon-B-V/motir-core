import { db } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemsService } from '@/lib/services/workItemsService';

// Seed for the custom-roles E2E (Story MOTIR-2257 · Subtask MOTIR-2487).
//
// ⚠️ DELIBERATELY THIN, AND THAT IS THE POINT. The sibling
// `roles-permissions-seed.ts` plants distinct headcounts because that spec reads
// COUNTS off the list. This spec AUTHORS a role in the browser, so anything it
// planted about custom roles would be a fixture standing where the test's own
// subject should be. What it seeds is only what the browser cannot reasonably
// build: two accounts, a project, and one work item to act on.
//
// ⚠️ THE PROJECT IS `open`, NOT `private`. On `open` the access level subtracts
// NOTHING, so the only thing deciding what the teammate can do is the role the
// admin composed in chapter 1 — which is precisely the claim chapter 4 makes. On
// `private` the level's own rail also withholds `work_item:edit` from
// non-members, and a refusal that two mechanisms both explain is evidence for
// neither.

export const CUSTOM_ROLES_E2E_PASSWORD = 'custom-roles-e2e-pass-7';

export interface CustomRolesSeed {
  adminEmail: string;
  /** The teammate the authored role is assigned to in chapter 3. */
  teammateEmail: string;
  teammateName: string;
  password: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  /** `CRE-1` — the work item chapter 4 acts on. */
  workItemKey: string;
}

export async function seedCustomRoles(prefix: string): Promise<CustomRolesSeed> {
  const owner = await usersService.createUser({
    email: `${prefix}-owner@example.com`,
    password: CUSTOM_ROLES_E2E_PASSWORD,
    name: 'Custom Roles Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Custom Roles E2E',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'Custom Roles E2E Project',
    identifier: 'CRE',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };

  // ⚠️ SERIAL, NOT `Promise.all` — the same reason the sibling seed spells out:
  // each account is a bcrypt hash plus its own transaction, and the acceptance
  // lane's global undici MockAgent taxes every non-intercepted origin enough to
  // make Prisma's 5s interactive-transaction budget genuinely reachable.
  const teammate = await usersService.createUser({
    email: `${prefix}-teammate@example.com`,
    password: CUSTOM_ROLES_E2E_PASSWORD,
    name: 'Robin Vega',
  });
  await workspacesService.addMember({ userId: teammate.id, workspaceId: workspace.id });
  await projectMembersService.addMember({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    targetUserId: teammate.id,
    role: 'member',
  });

  // ⚠️ THE OWNER GETS NO PROJECT MEMBERSHIP, AND DOES NOT NEED ONE.
  // `createProject` does not seat its creator, and on an `open` project nothing
  // seats anybody — the sibling seed only ends up with an owner membership
  // because going `private` auto-enrols every workspace member, which it then has
  // to PROMOTE. Here the owner manages through the workspace-manager rail (a
  // workspace owner always passes the project-management gate), which is the
  // shipped path an admin actually takes. Adding a membership to make the fixture
  // look tidier would test a configuration the product does not create.

  // One work item, so chapter 4 has a real surface to be refused at and a real
  // comment to succeed at.
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'Wire the settings rail' },
    { userId: owner.id, workspaceId: workspace.id },
  );

  // Both accounts land on THIS project when they sign in — otherwise a
  // `/settings/project` visit resolves against whatever `getActiveProject`
  // happens to pick, which is not a thing a spec should leave to chance.
  for (const userId of [owner.id, teammate.id]) {
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  // Assert the fixture is what the spec assumes, HERE — a mis-seeded role would
  // turn chapter 3's "change a teammate to Contributor" into a test of the seed.
  const memberships = await db.projectMembership.findMany({
    where: { projectId: project.id },
    select: { userId: true, role: true, roleDefinitionId: true },
  });
  if (memberships.length !== 1 || memberships[0]!.userId !== teammate.id) {
    throw new Error(
      `custom-roles-seed: expected exactly the teammate's membership, got ${memberships.length}`,
    );
  }
  if (memberships[0]!.role !== 'member') {
    throw new Error(`custom-roles-seed: the teammate must start on a BUILT-IN role`);
  }
  if (memberships.some((m) => m.roleDefinitionId !== null)) {
    throw new Error('custom-roles-seed: nobody may start on a custom role — the spec authors it');
  }

  return {
    adminEmail: owner.email,
    teammateEmail: teammate.email,
    teammateName: 'Robin Vega',
    password: CUSTOM_ROLES_E2E_PASSWORD,
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    workItemKey: item.identifier,
  };
}
