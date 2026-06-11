import type { Prisma } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import type { Project } from '@prisma/client';
import {
  canBrowse,
  canComment,
  canEdit,
  canManageWatchers,
  canModerateComments,
  type ProjectAccessInputs,
} from '@/lib/projects/access';
import { isWorkspaceManager } from '@/lib/projects/roles';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// projectAccessService — the ENFORCEMENT half of the Story 6.4 access model
// (Subtask 6.4.3). It resolves the three policy inputs (the project's access
// level + the actor's workspace role + their project role) and applies the pure
// `canBrowse` / `canEdit` policy from `lib/projects/access.ts`, throwing typed
// errors the route layer maps to HTTP status codes. This is the gate the rest
// of the PM core has been deferring with `// TODO(6.4)` notes — threaded into
// the project / board / issue READS (canBrowse) and their WRITE paths (canEdit)
// in the same change.
//
// The management write path (add/remove member, set role/access) is 6.4.4's
// `projectMembersService` and is DELIBERATELY separate: that gate is "are you a
// project ADMIN"; this one is "may you browse / edit at all".
//
// `tx` is OPTIONAL on every method, matching the two binding patterns already
// in the codebase:
//   * A caller already inside a transaction (the write paths: createWorkItem,
//     moveCard, …) passes its `tx` so the gate reads share the snapshot AND the
//     RLS workspace GUC the enclosing `withWorkspaceContext` / `db.$transaction`
//     bound — required under the non-bypass prodect_app role.
//   * A plain read path (getBoard, getProjectIssuesList, …) calls without `tx`;
//     the reads go through the `db` singleton, exactly like the surrounding
//     read does (RLS is bound by the request middleware in prod, inert under
//     the dev/CI BYPASSRLS role).

/** The minimal actor context the gate needs — satisfied by both ServiceContext and WorkspaceContext. */
export interface AccessActorContext {
  userId: string;
  workspaceId: string;
}

/**
 * Resolve the policy inputs for `(actor, project)`. Throws ProjectNotFoundError
 * (→ 404, no existence leak) when the project is missing OR lives in another
 * workspace — a cross-tenant id must be indistinguishable from a never-existed
 * one (finding #26), so the gate can never confirm a foreign project exists.
 */
async function resolveInputs(
  projectId: string,
  ctx: AccessActorContext,
  tx?: Prisma.TransactionClient,
): Promise<ProjectAccessInputs> {
  const project = await projectRepository.findById(projectId, tx);
  if (!project || project.workspaceId !== ctx.workspaceId) {
    throw new ProjectNotFoundError(projectId);
  }
  const workspaceMembership = tx
    ? await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
        ctx.userId,
        ctx.workspaceId,
        tx,
      )
    : await workspaceMembershipRepository.findByUserAndWorkspace(ctx.userId, ctx.workspaceId);
  const projectMembership = await projectMembershipRepository.findByUserAndProject(
    ctx.userId,
    projectId,
    tx,
  );
  return {
    accessLevel: project.accessLevel,
    workspaceRole: workspaceMembership?.role ?? null,
    projectRole: projectMembership?.role ?? null,
  };
}

export const projectAccessService = {
  /**
   * The actor's capabilities on a project — `{ canBrowse, canEdit }`. The
   * non-throwing form, for callers that FILTER rather than reject (the project
   * switcher in 6.4.6 lists only browsable projects) or render edit affordances
   * conditionally. Throws only ProjectNotFoundError (the project must resolve).
   */
  async getCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canEdit: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return { canBrowse: canBrowse(inputs), canEdit: canEdit(inputs) };
  },

  /**
   * The actor's COMMENT-domain capabilities on a project (Story 5.1 · Subtask
   * 5.1.2) — one `resolveInputs` round-trip feeding the three comment gates:
   * `canBrowse` (may they see the issue at all — the 404 gate), `canComment`
   * (Jira's "Add comments"), `canModerate` (Jira's "Edit all / Delete all
   * comments" — project admin or workspace owner/admin). `accessLevel` rides
   * along so the caller can scope mention candidates via
   * `assignableMembersService` without re-reading the project. Throws only
   * ProjectNotFoundError (cross-workspace project ids stay hidden).
   */
  async getCommentCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    canBrowse: boolean;
    canComment: boolean;
    canModerate: boolean;
    accessLevel: ProjectAccessInputs['accessLevel'];
  }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return {
      canBrowse: canBrowse(inputs),
      canComment: canComment(inputs),
      canModerate: canModerateComments(inputs),
      accessLevel: inputs.accessLevel,
    };
  },

  /**
   * The actor's WATCHER-domain capabilities on a project (Story 5.4 · Subtask
   * 5.4.4) — one `resolveInputs` round-trip feeding both watcher gates:
   * `canBrowse` (may they see the issue at all — the 404 gate; browsing is
   * ALL that self watch/unwatch needs, the verified "watching is not editing"
   * split) and `canManageWatchers` (Jira's "Manage watchers" — add/remove
   * OTHERS; project admin or workspace owner/admin). Throws only
   * ProjectNotFoundError (cross-workspace project ids stay hidden).
   */
  async getWatcherCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canManageWatchers: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return { canBrowse: canBrowse(inputs), canManageWatchers: canManageWatchers(inputs) };
  },

  /**
   * Filter a workspace's projects down to the ones the actor may BROWSE — the
   * switcher / nav / command-palette list (Subtask 6.4.6) shows only these, so a
   * private project the actor isn't on is ABSENT (never shown-then-denied). Takes
   * the already-loaded `Project` rows (each carries `accessLevel`) and resolves
   * the actor's roles in ONE pass — workspace role once, all project memberships
   * in a single query — then applies the pure `canBrowse` policy in memory (no
   * N+1). A workspace owner/admin keeps every project; a non-member gets none.
   */
  async filterBrowsable<T extends Pick<Project, 'id' | 'accessLevel'>>(
    projects: T[],
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<T[]> {
    if (projects.length === 0) return [];
    const workspaceMembership = tx
      ? await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
          ctx.userId,
          ctx.workspaceId,
          tx,
        )
      : await workspaceMembershipRepository.findByUserAndWorkspace(ctx.userId, ctx.workspaceId);
    const workspaceRole = workspaceMembership?.role ?? null;
    // Owner/admin always browse everything; a non-member never browses any.
    if (isWorkspaceManager(workspaceRole)) return projects;
    if (workspaceRole == null) return [];
    const memberships = await projectMembershipRepository.findByUserAndProjects(
      ctx.userId,
      projects.map((p) => p.id),
      tx,
    );
    const projectRoleById = new Map(memberships.map((m) => [m.projectId, m.role]));
    return projects.filter((p) =>
      canBrowse({
        accessLevel: p.accessLevel,
        workspaceRole,
        projectRole: projectRoleById.get(p.id) ?? null,
      }),
    );
  },

  /**
   * Whether the actor may browse the project, given already-resolved inputs.
   * Pure-policy convenience re-export so the switcher filter (6.4.6) can decide
   * over a batch of inputs without a per-project round-trip.
   */
  canBrowse,
  canEdit,

  /**
   * Assert the actor may BROWSE the project — gate the read paths. Throws
   * ProjectAccessDeniedError('browse') (→ 404, hidden) when they cannot.
   */
  async assertCanBrowse(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
  },

  /**
   * Assert the actor may EDIT the project — gate the write paths. A non-browser
   * is rejected as 'browse' FIRST (→ 404, the project stays hidden — never leak
   * "it exists but you can't write" to someone who can't even see it); a browser
   * who can't edit is rejected as 'edit' (→ 403, read-only). One resolve, both
   * checks, so a single round-trip gates the write.
   */
  async assertCanEdit(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
    if (!canEdit(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },
};
