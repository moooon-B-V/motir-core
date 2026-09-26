import { db } from './db-reset';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { PermissionKey } from '@/lib/permissions/catalog';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
  setWorkspaceRoleFor,
} from '../../helpers/workspaceRoleFixtures';

// Seed for Story MOTIR-2258's E2E + acceptance recording (Subtask MOTIR-2479).
//
// ⚠️ THE PERSONAS ARE PROJECT ROLES ON PLAIN WORKSPACE MEMBERS, never the
// workspace owner. The owner rides the always-pass rail — every assertion below
// would pass on the pre-story code with an owner driving, which would make the
// whole spec a very expensive way to prove nothing. This is the same trap
// MOTIR-2368's seed calls out, and it is worth repeating because it is silent.

export const PERMISSION_GATED_PASSWORD = 'permission-gated-ui-e2e-pass-123';
export const PERMISSION_GATED_PROJECT_KEY = 'PGU';

export interface PermissionGatedSeed {
  workspaceId: string;
  projectId: string;
  itemKey: string;
  adminEmail: string;
  memberEmail: string;
  viewerEmail: string;
  /** A CUSTOM role holding `project:browse` + `board:configure` (MOTIR-5319). */
  boardsOnlyEmail: string;
  /** A CUSTOM role holding `project:browse` + `workflow:manage` (MOTIR-5319). */
  workflowOnlyEmail: string;
  password: string;
}

/**
 * An `open` project with an admin, a member and a viewer, each with the active
 * project pinned so signing in lands them straight in the project shell.
 *
 * `open` is deliberate: it keeps `project:browse` out of the story. Every
 * persona can browse, so every difference the spec observes is a difference in
 * the administrative keys this story actually gates on.
 */
export async function seedPermissionGatedUi(slug: string): Promise<PermissionGatedSeed> {
  const owner = await usersService.createUser({
    email: `pgu-owner-${slug}@example.com`,
    password: PERMISSION_GATED_PASSWORD,
    name: 'Olivia Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Permission-gated Workspace',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: 'Permission-gated Project',
    identifier: PERMISSION_GATED_PROJECT_KEY,
  });

  async function pin(userId: string) {
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });
  }

  async function persona(label: string, role: 'admin' | 'member' | 'viewer') {
    const user = await usersService.createUser({
      email: `pgu-${label}-${slug}@example.com`,
      password: PERMISSION_GATED_PASSWORD,
      name: label,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    await db.projectMembership.create({
      data: { userId: user.id, projectId: project.id, workspaceId: workspace.id, role },
    });
    // Roles live on the workspace since MOTIR-6168.
    await setWorkspaceRoleFor(user.id, workspace.id, role);
    await pin(user.id);
    return user.id;
  }

  await persona('admin', 'admin');
  await persona('member', 'member');
  await persona('viewer', 'viewer');
  await pin(owner.id);

  // Two PARTIAL roles (MOTIR-5319) — hand-composed custom roles that open SOME
  // settings room but not Details. They are what the door's destination is for:
  // the built-in member and viewer get no door at all on the manage-only base,
  // so only a custom role can tell "the door goes to Details" from "the door goes
  // to the first room this actor can open".
  //
  // ⚠️ A custom role goes on through the SERVICES, not `persona`'s raw insert:
  // `projectMembership.role` and `roleDefinitionId` move together, and
  // `setRole` is the writer that keeps them aligned. `addMember` accepts only a
  // built-in, so the actor is added as a `member` first and then re-roled — the
  // same two steps `lesson-library-seed.ts` documents.
  const ownerCtx = { userId: owner.id, workspaceId: workspace.id };
  async function partialPersona(label: string, permissions: PermissionKey[]) {
    const role = await createCustomRoleAs({
      projectId: project.id,
      ctx: ownerCtx,
      name: label,
      permissions,
    });
    const user = await usersService.createUser({
      email: `pgu-${label}-${slug}@example.com`,
      password: PERMISSION_GATED_PASSWORD,
      name: label,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id });
    const member = { key: project.identifier, actorUserId: owner.id, ctx: ownerCtx };
    await addToProjectAs({ ...member, targetUserId: user.id, role: 'member' });
    await setProjectRoleAs({ ...member, targetUserId: user.id, role: role.id });
    await pin(user.id);
  }
  await partialPersona('boards-only', ['project:browse', 'board:configure']);
  await partialPersona('workflow-only', ['project:browse', 'workflow:manage']);

  // One work item, so the detail page has something to render and the in-place
  // treatments (panel 5) have a surface to be UNCHANGED on.
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A card everyone can see' },
    { userId: owner.id, workspaceId: workspace.id },
  );

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    itemKey: item.identifier,
    adminEmail: `pgu-admin-${slug}@example.com`,
    memberEmail: `pgu-member-${slug}@example.com`,
    viewerEmail: `pgu-viewer-${slug}@example.com`,
    boardsOnlyEmail: `pgu-boards-only-${slug}@example.com`,
    workflowOnlyEmail: `pgu-workflow-only-${slug}@example.com`,
    password: PERMISSION_GATED_PASSWORD,
  };
}
