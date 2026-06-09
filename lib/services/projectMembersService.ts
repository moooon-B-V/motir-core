import { Prisma } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withWorkspaceContext, type WorkspaceContext } from '@/lib/workspaces/context';
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
import {
  asAccessLevel,
  asProjectRole,
  isWorkspaceManager,
  type ProjectRole,
} from '@/lib/projects/roles';
import { toProjectAccessDTO, toProjectMemberDTO } from '@/lib/mappers/projectMemberMappers';
import type { ProjectAccessDTO, ProjectMemberDTO } from '@/lib/dto/projectMembers';

// projectMembersService — the write path for project membership + access
// (Story 6.4 · Subtask 6.4.4). 4-layer: this service owns the transaction, the
// validation, the project-admin gate, and the DTO mapping; the routes are thin
// HTTP transports; the single Prisma ops live in the repositories.
//
// AUTHORIZATION (two tiers, the Jira team-managed shape):
//   * Workspace owner/admin ALWAYS pass — the "site admin sees/manages every
//     project" tier (isWorkspaceManager on the workspace_membership.role).
//   * Otherwise the actor must hold a project membership with role `admin`.
//   * Everyone else → NotProjectAdminError (403).
// The browse/edit READ gate (canBrowse/canEdit per access level) is Subtask
// 6.4.3, deliberately NOT here — 6.4.4 is the management write path only.
//
// RLS: every method runs inside withWorkspaceContext(ctx) so the project +
// project_membership RLS policies see the per-transaction workspace GUC under
// the non-bypass prodect_app role. The project key is resolved INSIDE the same
// transaction (one service method = one transaction) so the gate read and the
// write share a snapshot.
//
// NO EXISTENCE LEAK (PRODECT_FINDINGS #26): the project is resolved by its
// workspace-scoped `identifier` — a key naming a project in ANOTHER workspace
// is indistinguishable from a non-existent one (both throw ProjectNotFoundError
// → 404), so a caller can't probe cross-tenant keys.

function resolveProjectInTx(key: string, ctx: WorkspaceContext, tx: Prisma.TransactionClient) {
  const identifier = key.trim().toUpperCase();
  return projectRepository.findByIdentifier(ctx.workspaceId, identifier, tx).then((project) => {
    if (!project) throw new ProjectNotFoundError(key);
    return project;
  });
}

/**
 * Assert the actor may MANAGE the project (add/remove members, set roles +
 * access). Passes for a workspace owner/admin (always) or a project admin;
 * throws NotProjectAdminError otherwise. Reads run through `tx` so the RLS
 * policies admit the rows under prodect_app.
 */
async function assertCanManage(
  actorUserId: string,
  workspaceId: string,
  projectId: string,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const wsMembership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
    actorUserId,
    workspaceId,
    tx,
  );
  if (wsMembership && isWorkspaceManager(wsMembership.role)) return;

  const projectMembership = await projectMembershipRepository.findByUserAndProject(
    actorUserId,
    projectId,
    tx,
  );
  if (projectMembership?.role === 'admin') return;

  throw new NotProjectAdminError(projectId);
}

function validateRole(role: string): ProjectRole {
  const parsed = asProjectRole(role);
  if (!parsed) throw new InvalidProjectRoleError(role);
  return parsed;
}

export interface ActorScopedInput {
  key: string;
  actorUserId: string;
  ctx: WorkspaceContext;
}

export const projectMembersService = {
  /**
   * List a project's members as DTOs. Available to any workspace member who can
   * resolve the project key (the per-access-level browse gate is 6.4.3); the
   * Members UI renders this read-only for non-admins. Reads inside
   * withWorkspaceContext so the project_membership RLS policy exposes the rows.
   */
  async listMembers(input: ActorScopedInput): Promise<ProjectMemberDTO[]> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      const rows = await projectMembershipRepository.findMembersByProject(project.id, tx);
      return rows.map(toProjectMemberDTO);
    });
  },

  /**
   * Read the project's current browse-access level (open / limited / private).
   * Available to any workspace member who can resolve the project key (the
   * Settings → Access control in 6.4.5 renders this; it's read-only for
   * non-admins). A pure read — no gate, no transaction-spanning write — so it
   * mirrors `listMembers`: resolve the project under withWorkspaceContext and
   * map to the DTO. The write counterpart is `setAccessLevel`.
   */
  async getAccess(input: ActorScopedInput): Promise<ProjectAccessDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      return toProjectAccessDTO(project);
    });
  },

  /**
   * Add a workspace member to the project with a project role. The target must
   * already be a member of the workspace (TargetNotWorkspaceMemberError → 400);
   * a duplicate add throws AlreadyProjectMemberError (409). Project-admin gated.
   */
  async addMember(
    input: ActorScopedInput & { targetUserId: string; role: string },
  ): Promise<ProjectMemberDTO> {
    const role = validateRole(input.role);
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertCanManage(input.actorUserId, input.ctx.workspaceId, project.id, tx);

      // The target must be a workspace member — a project can only draw from the
      // people already in its workspace (the add-member combobox in 6.4.5 is
      // scoped the same way).
      const targetWsMembership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
        input.targetUserId,
        input.ctx.workspaceId,
        tx,
      );
      if (!targetWsMembership) {
        throw new TargetNotWorkspaceMemberError(input.targetUserId, input.ctx.workspaceId);
      }

      try {
        await projectMembershipRepository.create(
          {
            workspaceId: input.ctx.workspaceId,
            projectId: project.id,
            userId: input.targetUserId,
            role,
          },
          tx,
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          throw new AlreadyProjectMemberError(input.targetUserId, project.id);
        }
        throw err;
      }

      const created = await projectMembershipRepository.findByUserAndProjectWithUser(
        input.targetUserId,
        project.id,
        tx,
      );
      // Just inserted in this tx, so it resolves — the non-null assertion is safe.
      return toProjectMemberDTO(created!);
    });
  },

  /**
   * Change a member's project role. Project-admin gated. Guards the last admin:
   * demoting the only `admin` throws LastProjectAdminError (409). The target
   * must already be a member (NotAProjectMemberError → 404).
   */
  async setRole(
    input: ActorScopedInput & { targetUserId: string; role: string },
  ): Promise<ProjectMemberDTO> {
    const role = validateRole(input.role);
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertCanManage(input.actorUserId, input.ctx.workspaceId, project.id, tx);

      const existing = await projectMembershipRepository.findByUserAndProject(
        input.targetUserId,
        project.id,
        tx,
      );
      if (!existing) throw new NotAProjectMemberError(input.targetUserId, project.id);

      // Last-admin guard: demoting the only admin would strand the project with
      // no project-level admin. The count + the update run in one tx so two
      // concurrent demotions can't both see count > 1.
      if (existing.role === 'admin' && role !== 'admin') {
        const adminCount = await projectMembershipRepository.countAdmins(project.id, tx);
        if (adminCount <= 1) throw new LastProjectAdminError(project.id);
      }

      await projectMembershipRepository.updateRole(input.targetUserId, project.id, role, tx);
      const updated = await projectMembershipRepository.findByUserAndProjectWithUser(
        input.targetUserId,
        project.id,
        tx,
      );
      return toProjectMemberDTO(updated!);
    });
  },

  /**
   * Remove a member from the project. Project-admin gated. Guards the last
   * admin (removing the only `admin` throws LastProjectAdminError → 409) and
   * 404s when the target isn't a member. Returns the removed member DTO.
   */
  async removeMember(
    input: ActorScopedInput & { targetUserId: string },
  ): Promise<ProjectMemberDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertCanManage(input.actorUserId, input.ctx.workspaceId, project.id, tx);

      const existing = await projectMembershipRepository.findByUserAndProjectWithUser(
        input.targetUserId,
        project.id,
        tx,
      );
      if (!existing) throw new NotAProjectMemberError(input.targetUserId, project.id);

      if (existing.role === 'admin') {
        const adminCount = await projectMembershipRepository.countAdmins(project.id, tx);
        if (adminCount <= 1) throw new LastProjectAdminError(project.id);
      }

      await projectMembershipRepository.deleteByUserAndProject(input.targetUserId, project.id, tx);
      return toProjectMemberDTO(existing);
    });
  },

  /**
   * Set the project's browse-access level (open / limited / private).
   * Project-admin gated. Going PRIVATE seeds every current workspace member as
   * a project `member` (skipping anyone already a member, so an admin keeps
   * their role) — the Jira "go private → keep the people who had access" shape,
   * so the owner + current users aren't locked out of a freshly-private project.
   */
  async setAccessLevel(input: ActorScopedInput & { level: string }): Promise<ProjectAccessDTO> {
    const level = asAccessLevel(input.level);
    if (!level) throw new InvalidAccessLevelError(input.level);

    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertCanManage(input.actorUserId, input.ctx.workspaceId, project.id, tx);

      if (level === 'private') {
        const workspaceMembers = await workspaceMembershipRepository.findMembersByWorkspace(
          input.ctx.workspaceId,
          tx,
        );
        await projectMembershipRepository.createManySkipDuplicates(
          workspaceMembers.map((m) => ({
            workspaceId: input.ctx.workspaceId,
            projectId: project.id,
            userId: m.userId,
            role: 'member' as const,
          })),
          tx,
        );
      }

      const updated = await projectRepository.setAccessLevel(project.id, level, tx);
      return toProjectAccessDTO(updated);
    });
  },
};
