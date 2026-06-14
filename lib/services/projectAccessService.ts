import type { Prisma } from '@prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import type { Project } from '@prisma/client';
import {
  canBrowse,
  canComment,
  canCommentPublicRequest,
  canCreateAttachments,
  canDeleteAllAttachments,
  canEdit,
  canManageProject,
  canManageWatchers,
  canModerateComments,
  canSubmitToTriage,
  canUpvotePublicRequest,
  type ProjectAccessInputs,
} from '@/lib/projects/access';
import { isWorkspaceManager } from '@/lib/projects/roles';
import {
  NotProjectAdminError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  savedFilterCapabilities,
  type SavedFilterProjectCapabilities,
} from '@/lib/savedFilters/access';

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

/**
 * Resolve the policy inputs for a PUBLIC-read actor — the ONE path that bypasses
 * the workspace-equality 404 guard (Story 6.12 · Subtask 6.12.3, ADR §2.2). The
 * existing `resolveInputs` is left UNTOUCHED, so the 404-not-403 cross-tenant
 * posture for non-public projects is fully preserved; THIS function is the single
 * auditable place the org/workspace boundary is crossed for READ, and ONLY for a
 * `public` project.
 *
 * `actorUserId` is NULLABLE: READ on a public project is anonymous (logged out /
 * a crawler), so a null actor resolves to null roles and the leading `public`
 * branch of `canBrowse` grants the read. An authenticated actor (cross-org
 * included) has their roles resolved against the PROJECT'S OWN workspace — a
 * cross-org viewer resolves to null roles (browse still granted by the public
 * branch), while a viewer who also happens to be a member of that workspace keeps
 * their richer role + normal capabilities.
 *
 * A NON-public project throws ProjectNotFoundError (→ 404) for ANY actor here
 * (anonymous or cross-org): it stays indistinguishable from never-existed, no
 * existence leak. Members reach a non-public project through the normal
 * workspace-scoped capability methods, never this public path.
 */
async function resolvePublicInputs(
  projectId: string,
  actorUserId: string | null,
  tx?: Prisma.TransactionClient,
): Promise<ProjectAccessInputs> {
  const project = await projectRepository.findById(projectId, tx);
  if (!project || project.accessLevel !== 'public') {
    throw new ProjectNotFoundError(projectId);
  }
  if (!actorUserId) {
    return { accessLevel: project.accessLevel, workspaceRole: null, projectRole: null };
  }
  const workspaceMembership = tx
    ? await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
        actorUserId,
        project.workspaceId,
        tx,
      )
    : await workspaceMembershipRepository.findByUserAndWorkspace(actorUserId, project.workspaceId);
  const projectMembership = await projectMembershipRepository.findByUserAndProject(
    actorUserId,
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
   * The actor's ATTACHMENT-domain capabilities on a project (Story 5.2 ·
   * Subtask 5.2.2) — one `resolveInputs` round-trip feeding the three
   * attachment gates, mirroring `getCommentCapabilities`: `canBrowse` (may
   * they see the issue at all — the 404 gate; browsing implies seeing +
   * downloading its attachments), `canCreate` (Jira's "Create attachments"),
   * `canDeleteAll` (Jira's "Delete all attachments" — project admin or
   * workspace owner/admin; uploaders delete their OWN regardless, checked by
   * the service). Throws only ProjectNotFoundError (cross-workspace project
   * ids stay hidden).
   */
  async getAttachmentCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canCreate: boolean; canDeleteAll: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return {
      canBrowse: canBrowse(inputs),
      canCreate: canCreateAttachments(inputs),
      canDeleteAll: canDeleteAllAttachments(inputs),
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
   * The actor's SAVED-FILTER-domain tier on a project (Story 6.2 · Subtask
   * 6.2.1) — one `resolveInputs` round-trip feeding the three saved-filter
   * gates (the getCommentCapabilities pattern): `canBrowse` (the 404 gate;
   * browsing is all that creating/starring PRIVATE filters needs — filters
   * are a read-layer construct, viewers included), `canShare` (role ≥ member
   * — may publish at visibility `project`), `isAdmin` (project admin or
   * workspace owner/admin — sees every row, manages the shared ones). The
   * per-row predicates live in lib/savedFilters/access.ts. Throws only
   * ProjectNotFoundError (cross-workspace project ids stay hidden).
   */
  async getSavedFilterCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<SavedFilterProjectCapabilities> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return savedFilterCapabilities(inputs);
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

  // --- Public-project access (Story 6.12 · Subtask 6.12.3) -------------------
  // These methods go through `resolvePublicInputs` — the SINGLE place the
  // workspace-equality 404 guard is skipped, and ONLY for a `public` project.
  // `actorUserId` is nullable on the READ paths (anonymous public READ) and
  // REQUIRED on the three write-grant asserts (sign-in-to-act: the route has
  // already gated on a session). The pure grant predicates are also re-exported
  // below so a batch/caller can decide without a per-project round-trip.
  canSubmitToTriage,
  canUpvotePublicRequest,
  canCommentPublicRequest,

  /**
   * The actor's PUBLIC-project capabilities — `{ canBrowse, canSubmitToTriage,
   * canUpvotePublicRequest, canCommentPublicRequest }` (the 6.12.4 view + the
   * 6.12.5 / 6.12.6 write entry points). `actorUserId` is NULLABLE: an anonymous
   * (logged-out) reader resolves to `canBrowse: true`; the write grants are true
   * for any account on a public project (authentication is enforced upstream — the
   * write routes gate on a session). Throws ProjectNotFoundError on a non-public
   * project (no existence leak, cross-org or anonymous).
   */
  async getPublicCapabilities(
    projectId: string,
    actorUserId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<{
    canBrowse: boolean;
    canSubmitToTriage: boolean;
    canUpvotePublicRequest: boolean;
    canCommentPublicRequest: boolean;
  }> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    return {
      canBrowse: canBrowse(inputs),
      canSubmitToTriage: canSubmitToTriage(inputs),
      canUpvotePublicRequest: canUpvotePublicRequest(inputs),
      canCommentPublicRequest: canCommentPublicRequest(inputs),
    };
  },

  /**
   * Assert the actor may BROWSE the public project — the anonymous public-read
   * gate (6.12.4). `actorUserId` nullable (logged out / crawler). Throws
   * ProjectNotFoundError (→ 404) on a non-public project (indistinguishable from
   * never-existed); for a public project `canBrowse` is always true, so the
   * assert resolves and returns.
   */
  async assertCanBrowsePublic(
    projectId: string,
    actorUserId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
  },

  /**
   * Assert the (authenticated) actor may SUBMIT a request into the public
   * project's triage (6.12.5). `actorUserId` is REQUIRED — the route has gated on
   * a session (sign-in-to-act). Throws ProjectNotFoundError (→ 404) on a
   * non-public project; ProjectAccessDeniedError('edit') if the grant is denied.
   */
  async assertCanSubmitToTriage(
    projectId: string,
    actorUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canSubmitToTriage(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * Assert the (authenticated) actor may UPVOTE a public request (6.12.6).
   * `actorUserId` REQUIRED. Throws ProjectNotFoundError (→ 404) on a non-public
   * project; ProjectAccessDeniedError('edit') if the grant is denied.
   */
  async assertCanUpvotePublicRequest(
    projectId: string,
    actorUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canUpvotePublicRequest(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * Assert the (authenticated) actor may COMMENT on a public request (6.12.6).
   * `actorUserId` REQUIRED. Throws ProjectNotFoundError (→ 404) on a non-public
   * project; ProjectAccessDeniedError('edit') if the grant is denied.
   */
  async assertCanCommentPublicRequest(
    projectId: string,
    actorUserId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canCommentPublicRequest(inputs)) throw new ProjectAccessDeniedError(projectId, 'edit');
  },

  /**
   * The actor's PROJECT-SETTINGS-area capabilities — `{ canBrowse, canEdit,
   * canManage }` in ONE `resolveInputs` round-trip (Story 6.5 · Subtask 6.5.2).
   * Feeds the (authed) shell: `canEdit` drives the `ProjectAccessProvider`
   * edit-affordance gating (unchanged), while `{ canBrowse, canManage }` drive
   * the settings-nav registry's per-entry `access` predicates (a non-browser
   * sees neither nav entry nor page; admin-only entries — Story 6.6 — gate on
   * `canManage`). Replacing the bare `getCapabilities` call in the layout with
   * this keeps the round-trip count at one. Throws only ProjectNotFoundError.
   */
  async getSettingsCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canEdit: boolean; canManage: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return {
      canBrowse: canBrowse(inputs),
      canEdit: canEdit(inputs),
      canManage: canManageProject(inputs),
    };
  },

  /**
   * The actor's project-ADMIN capability — `{ canBrowse, canManage }`. The
   * non-throwing form, for the admin-only settings surfaces (automation rules,
   * Story 6.6) that render their nav entry + page only when `canManage`. Throws
   * only ProjectNotFoundError (the project must resolve; a non-browser still
   * reads as 404 so the surface stays hidden, never "exists but you can't").
   */
  async getManageCapabilities(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<{ canBrowse: boolean; canManage: boolean }> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return { canBrowse: canBrowse(inputs), canManage: canManageProject(inputs) };
  },

  /**
   * Assert the actor may ADMINISTER the project — gate the project-settings
   * write paths (automation CRUD in Story 6.6). A non-browser is rejected as
   * ProjectNotFoundError FIRST (→ 404, the project stays hidden — the same
   * no-existence-leak rule `assertCanEdit` follows, but a settings surface a
   * viewer can't even see must look missing, not forbidden); a browser who is
   * not an admin is rejected as NotProjectAdminError (→ 403). One resolve, both
   * checks.
   */
  async assertCanManage(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectNotFoundError(projectId);
    if (!canManageProject(inputs)) throw new NotProjectAdminError(projectId);
  },
};
