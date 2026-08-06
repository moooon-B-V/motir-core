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
  TargetNotWorkspaceMemberError,
} from '@/lib/projects/errors';
import { resolveProjectByKeyWithAliasInTx } from '@/lib/projects/resolveByKey';
import { asAccessLevel, asProjectRole, type ProjectRole } from '@/lib/projects/roles';
import { projectAccessService } from '@/lib/services/projectAccessService';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { toProjectAccessDTO, toProjectMemberDTO } from '@/lib/mappers/projectMemberMappers';
import type { ProjectAccessDTO, ProjectMemberDTO } from '@/lib/dto/projectMembers';

// projectMembersService — the write path for project membership + access
// (Story 6.4 · Subtask 6.4.4). 4-layer: this service owns the transaction, the
// validation, the project-admin gate, and the DTO mapping; the routes are thin
// HTTP transports; the single Prisma ops live in the repositories.
//
// AUTHORIZATION — ⚠️ ONE POLICY, ASKED BY KEY (Story MOTIR-2256 · MOTIR-2295).
// Until this card, this file declared its OWN module-private `assertCanManage`
// that re-derived the admin answer from scratch (workspace-manager rail, then
// `projectMembership?.role === 'admin'`). That was a SECOND implementation of
// the access policy — it happened to agree with `lib/permissions/resolve.ts` and
// nothing kept it that way. MOTIR-2255 moved the policy into one place precisely
// so this could not happen; it is deleted, and every gate here now asks
// `projectAccessService.assertPermission` for a named key:
//
//   * `addMember` / `setRole` / `removeMember`  → `member:manage`
//   * `setAccessLevel`                          → `project:manage_access`
//     Its own key on purpose: who is IN the project and how open the project is
//     to the workspace are different decisions, and Jira separates them too.
//   * `listMembers` / `getAccess`               → `project:browse`
//
// ⚠️ THE TWO READS ARE NOW GATED, AND THAT IS A DELIBERATE HOLE CLOSED. They
// were documented as "available to any workspace member who can resolve the
// project key". Read on this branch, `resolveProjectInTx` applies NO browse gate
// — its own header says "the access gate (assertCanBrowse) is the CALLER's job"
// — so a workspace member who could not browse a private project could still
// read its member list and its access level. `project:browse` is the right gate
// (never a `manage` key: the Members page renders READ-ONLY for non-admins by
// design, and changing what is SHOWN is MOTIR-2258's surface, not this one).
//
// Two consequences of routing through the shared gate, both intended:
//   * A NON-BROWSER now gets ProjectNotFoundError (404) where the private assert
//     returned NotProjectAdminError (403). That is the no-existence-leak posture
//     (finding #26) this file already claims below — a private project must look
//     missing, not forbidden.
//   * A browser who lacks the key gets PermissionDeniedError (403) rather than
//     NotProjectAdminError. Same status; the code changes from
//     `NOT_PROJECT_ADMIN` to `PERMISSION_DENIED`, which no consumer of these
//     three routes reads (`ProjectMembersSettings` special-cases only
//     `LAST_PROJECT_ADMIN` and falls through to a generic message).
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

// Alias-aware (Story 6.8 · Subtask 6.8.2): resolves the live identifier first
// and the retired-key alias table on a miss, through the SINGLE central
// resolver, so the `/api/projects/[key]` members + access routes SERVE old keys
// identically to the live key (the verified Jira REST behaviour). `viaAlias` is
// irrelevant to a management write (the response carries the canonical project
// either way), so it's discarded here. Still no existence leak — the central
// resolver throws ProjectNotFoundError for a missing/cross-workspace/released
// key, exactly as before.
function resolveProjectInTx(key: string, ctx: WorkspaceContext, tx: Prisma.TransactionClient) {
  return resolveProjectByKeyWithAliasInTx(key, ctx.workspaceId, tx).then((r) => r.project);
}

/**
 * The actor context the shared gate takes. Built from `actorUserId` rather than
 * `ctx.userId` so the gate answers about the ACTOR the caller named — the two
 * are the same in every shipped route, and the private assert this replaces took
 * `actorUserId` explicitly, so keeping that is the behaviour-preserving reading.
 */
function actorContext(input: ActorScopedInput): { userId: string; workspaceId: string } {
  return { userId: input.actorUserId, workspaceId: input.ctx.workspaceId };
}

/**
 * Assert the actor holds `key` on the project, inside the enclosing transaction.
 * A thin adapter onto `projectAccessService.assertPermission` — `tx` is threaded
 * so the gate's reads see the per-transaction workspace GUC the RLS policies
 * need under prodect_app, and share the snapshot the write will use.
 */
function assertPermission(
  input: ActorScopedInput,
  projectId: string,
  key: PermissionKey,
  tx: Prisma.TransactionClient,
): Promise<void> {
  return projectAccessService.assertPermission(projectId, actorContext(input), key, tx);
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
   * List a project's members as DTOs. BROWSE-gated (MOTIR-2295): any actor who
   * can see the project may read who is on it, and the Members UI renders that
   * read-only for non-admins — a `manage` key here would hide the page from the
   * people it is meant to inform. Before this card it was ungated, because
   * `resolveProjectInTx` resolves the key without applying the access gate, so a
   * workspace member who could not browse a private project could still read its
   * member list. Reads inside withWorkspaceContext so the project_membership RLS
   * policy exposes the rows.
   */
  async listMembers(input: ActorScopedInput): Promise<ProjectMemberDTO[]> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertPermission(input, project.id, 'project:browse', tx);
      const rows = await projectMembershipRepository.findMembersByProject(project.id, tx);
      return rows.map(toProjectMemberDTO);
    });
  },

  /**
   * Read the project's current browse-access level (open / limited / private).
   * BROWSE-gated, for the same reason as `listMembers` (MOTIR-2295): the
   * Settings → Access control pane in 6.4.5 renders it read-only for non-admins,
   * so the gate is `project:browse`, never `project:manage_access` — that key is
   * the WRITE counterpart, `setAccessLevel`.
   */
  async getAccess(input: ActorScopedInput): Promise<ProjectAccessDTO> {
    return withWorkspaceContext(input.ctx, async (tx) => {
      const project = await resolveProjectInTx(input.key, input.ctx, tx);
      await assertPermission(input, project.id, 'project:browse', tx);
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
      await assertPermission(input, project.id, 'member:manage', tx);

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
      await assertPermission(input, project.id, 'member:manage', tx);

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
      await assertPermission(input, project.id, 'member:manage', tx);

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
      await assertPermission(input, project.id, 'project:manage_access', tx);

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

      // Stamp `madePublicAt` only on the transition INTO `public` (Subtask
      // 6.13.4 — the project square's Recent rank's "newest" axis). A re-save of
      // an already-public project keeps its original go-public moment.
      const stampMadePublicAt = level === 'public' && project.accessLevel !== 'public';
      const updated = await projectRepository.setAccessLevel(
        project.id,
        level,
        { stampMadePublicAt },
        tx,
      );
      return toProjectAccessDTO(updated);
    });
  },
};
