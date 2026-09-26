import type { Prisma, WorkspaceRole } from '@/generated/prisma/client';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { AlreadyProjectMemberError } from '@/lib/projects/errors';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from './adminDb';

// Fixture doors for the WORKSPACE role (Story MOTIR-6168 · MOTIR-6464).
//
// Roles live on the workspace: a person holds ONE role there — Manager · Member ·
// Viewer, or a workspace custom role — and it is their role in every project. A
// project membership carries no role; it only says "added to this project",
// which a limited / private project reads. So a fixture that used to put
// somebody on a PROJECT role now does the two things that role meant:
//   * adds them to the project (so a limited / private project admits them), and
//   * gives them the matching WORKSPACE role — the DECISION's mapping: a project
//     `admin` (or the legacy `owner`) → `manager`, `member` → `member`,
//     `viewer` → `viewer`, and a custom role id → that workspace custom role.
//
// The workspace role is written straight to the row through the owner client:
// the fixture is arranging a state, not exercising the role-change door (that is
// `workspacesService.setMemberRole`, tested on its own).

const BUILT_IN = new Set(['owner', 'admin', 'manager', 'member', 'viewer']);

/** The DECISION's mapping from a legacy role name to a workspace role. */
export function toWorkspaceRole(role: string): WorkspaceRole {
  if (role === 'owner' || role === 'admin' || role === 'manager') return 'manager';
  if (role === 'viewer') return 'viewer';
  return 'member';
}

/**
 * Put a workspace member on a workspace role: a built-in by name (legacy names
 * mapped), or a workspace custom role by its id (held at the `member` tier).
 */
export async function setWorkspaceRoleFor(
  userId: string,
  workspaceId: string,
  role: string,
): Promise<void> {
  const data = BUILT_IN.has(role)
    ? { workspaceRole: toWorkspaceRole(role), roleDefinitionId: null }
    : { workspaceRole: 'member' as const, roleDefinitionId: role };
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId } },
    data,
  });
}

interface ProjectRoleInput {
  key: string;
  actorUserId: string;
  ctx: WorkspaceContext;
  targetUserId: string;
  role: string;
}

/**
 * What `projectMembersService.addMember({ …, role })` used to mean: add the
 * person to the project (idempotently) and give them the workspace role the
 * project role maps to.
 */
export async function addToProjectAs(
  input: ProjectRoleInput,
): Promise<{ userId: string; name: string; email: string }> {
  const { role, ...rest } = input;
  let added: { userId: string; name: string; email: string } | null = null;
  try {
    added = await projectMembersService.addMember(rest);
  } catch (err) {
    if (!(err instanceof AlreadyProjectMemberError)) throw err;
  }
  await setWorkspaceRoleFor(input.targetUserId, input.ctx.workspaceId, role);
  return added ?? { userId: input.targetUserId, name: '', email: '' };
}

/** What `projectMembersService.setRole({ …, role })` used to mean: the workspace role. */
export async function setProjectRoleAs(input: ProjectRoleInput): Promise<{ userId: string }> {
  await setWorkspaceRoleFor(input.targetUserId, input.ctx.workspaceId, input.role);
  return { userId: input.targetUserId };
}

/**
 * What `projectRoleDefinitionService.create(...)` used to mean: a custom role —
 * now authored on the WORKSPACE, so it holds in every project of it.
 */
export async function createCustomRoleAs(input: {
  projectId?: string;
  ctx: WorkspaceContext;
  name: unknown;
  permissions: unknown;
}): Promise<{ id: string; name: string; permissions: PermissionKey[] }> {
  const row = await adminDb.workspaceRoleDefinition.create({
    data: {
      workspaceId: input.ctx.workspaceId,
      name: String(input.name),
      permissions: input.permissions as string[],
    },
  });
  return { id: row.id, name: row.name, permissions: row.permissions as PermissionKey[] };
}

/**
 * What `projectMembershipRepository.setRoleDefinition(userId, projectId, …)` used
 * to write: the person's role, now on their WORKSPACE membership (the project's
 * workspace). A custom role id must name a WORKSPACE custom role.
 */
export async function setProjectRoleDefinitionFor(
  userId: string,
  projectId: string,
  assignment: { roleDefinitionId: string | null; role: string },
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const client = tx ?? adminDb;
  const project = await client.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  await client.workspaceMembership.update({
    where: { userId_workspaceId: { userId, workspaceId: project.workspaceId } },
    data: assignment.roleDefinitionId
      ? { workspaceRole: 'member', roleDefinitionId: assignment.roleDefinitionId }
      : { workspaceRole: toWorkspaceRole(assignment.role), roleDefinitionId: null },
  });
}
