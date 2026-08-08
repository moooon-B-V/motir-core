import type { Prisma } from '@/generated/prisma/client';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { projectMembershipRepository } from '@/lib/repositories/projectMembershipRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { MemberRole, Project } from '@/generated/prisma/client';
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
import { asProjectRole, isWorkspaceManager, type ProjectRole } from '@/lib/projects/roles';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import {
  savedFilterCapabilities,
  type SavedFilterProjectCapabilities,
} from '@/lib/savedFilters/access';
import { hasPermission, resolvePermissions } from '@/lib/permissions/resolve';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { toActorPermissionsDTO, toRoleCatalogDTO } from '@/lib/mappers/permissionMappers';
import type { ActorPermissionsDTO, RoleCatalogDTO } from '@/lib/dto/permissions';

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
  canManageProject,

  /**
   * Resolve `canEdit` for MANY users at once (MOTIR-1910) — "which of these
   * people may change this project?", answered by the same policy every single-
   * actor gate uses.
   *
   * Built for team code access (`docs/decisions/project-repository-set.md` §3
   * Q1): a repository Motir created is handed to exactly the members who can
   * already edit the project, so the grant reuses the product's own membership
   * rule rather than inventing a second one for code. Anything else asking "who
   * on this project can act?" belongs here too — the point is that the answer has
   * ONE implementation.
   *
   * ⚠️ TWO FULL MEMBERSHIP READS, not one per user. The policy needs BOTH roles
   * for each candidate (a workspace owner/admin passes regardless of project
   * membership; an `open` project needs no project membership at all), so a
   * per-user resolve would be 2N round-trips to answer one question about a team.
   * The two lists are workspace-bounded and small.
   *
   * A user absent from BOTH lists resolves to `(null, null)` and is denied by the
   * null-workspace-role rail — the correct answer for someone who is not in the
   * workspace, and the reason this cannot accidentally admit a stranger.
   */
  async resolveCanEditForUsers(
    projectId: string,
    userIds: string[],
    ctx: AccessActorContext,
  ): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (userIds.length === 0) return result;

    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }

    return withWorkspaceContext(
      { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
      async (tx) => {
        const [workspaceMembers, projectMembers] = await Promise.all([
          workspaceMembershipRepository.findMembersByWorkspace(ctx.workspaceId, tx),
          projectMembershipRepository.findMembersByProject(projectId, tx),
        ]);
        const workspaceRoles = new Map(workspaceMembers.map((m) => [m.userId, m.role]));
        const projectRoles = new Map(projectMembers.map((m) => [m.userId, m.role]));

        for (const userId of userIds) {
          result.set(
            userId,
            canEdit({
              accessLevel: project.accessLevel,
              workspaceRole: workspaceRoles.get(userId) ?? null,
              projectRole: projectRoles.get(userId) ?? null,
            }),
          );
        }
        return result;
      },
    );
  },

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
   * Assert the actor may BROWSE the public project AND report whether they are a
   * project MEMBER (Story 6.14 · Subtask 6.14.4). One `resolvePublicInputs`
   * round-trip serves both: the same anonymous/cross-org browse gate as {@link
   * assertCanBrowsePublic}, plus the member/non-member split the epic-privacy
   * exclusion keys off. `isMember` is `true` iff the actor holds ANY role in the
   * project's workspace OR the project itself (a workspace member viewing the
   * public `/p` surface bypasses the exclusion); an anonymous reader, a crawler,
   * and a cross-org account all resolve to `isMember: false` (null roles) — the
   * population a private epic's children must never reach. Throws
   * ProjectNotFoundError (→ 404) on a non-public project (no existence leak).
   */
  async resolvePublicBrowse(
    projectId: string,
    actorUserId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<{ isMember: boolean; canManage: boolean }> {
    const inputs = await resolvePublicInputs(projectId, actorUserId, tx);
    if (!canBrowse(inputs)) throw new ProjectAccessDeniedError(projectId, 'browse');
    return {
      isMember: inputs.workspaceRole != null || inputs.projectRole != null,
      // The in-place "Edit" affordance gate for the public page (Subtask 6.16.3)
      // — admin-only; an anonymous / cross-org viewer resolves to `false`.
      canManage: canManageProject(inputs),
    };
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
   * Assert the actor holds `key` on the project — THE administrative gate
   * (Story MOTIR-2256 · Subtask MOTIR-2293). One method that takes the KEY,
   * rather than one method per question: a role is a permission SET, so the
   * number of questions the code can be asked is the size of the catalog, and a
   * method per question does not scale to a catalog that grows (nor to Story
   * MOTIR-2257's custom roles, where the set is chosen by a person).
   *
   * The refusal ORDER is `assertCanManage`'s, unchanged, and it is load-bearing:
   *   1. A NON-BROWSER is rejected as ProjectNotFoundError (→ 404) FIRST. A
   *      settings surface a viewer cannot even see must look MISSING, not
   *      forbidden — the no-existence-leak posture (finding #26). This runs
   *      before the key test, so a 403 never confirms a project the actor may
   *      not browse.
   *   2. A BROWSER who does not hold the key is rejected with a typed 403.
   *
   * ⚠️ THE 403 SHAPE HAS A COMPATIBILITY BRANCH. `project:administer` keeps
   * throwing NotProjectAdminError, so the shipped `NOT_PROJECT_ADMIN` wire code
   * keeps reaching the three places that read it by string (the workflow
   * settings action, `lib/workflows/errors.ts`, and the components-settings
   * editor test). Every OTHER key throws PermissionDeniedError, which carries
   * the key it asked for. Both map to 403 in `projectErrorResponse`. Collapse
   * the branch once nothing reads the old code — see the note on
   * PermissionDeniedError.
   *
   * One `resolveInputs` round-trip; `tx` threads through it so a caller already
   * inside a transaction shares the snapshot AND the RLS workspace GUC that
   * transaction bound.
   */
  async assertPermission(
    projectId: string,
    ctx: AccessActorContext,
    key: PermissionKey,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    if (!canBrowse(inputs)) throw new ProjectNotFoundError(projectId);
    if (hasPermission(inputs, key)) return;
    if (key === 'project:administer') throw new NotProjectAdminError(projectId);
    throw new PermissionDeniedError(projectId, key);
  },

  /**
   * Assert the actor may ADMINISTER the project — gate the project-settings
   * write paths (automation CRUD in Story 6.6). A non-browser is rejected as
   * ProjectNotFoundError FIRST (→ 404, the project stays hidden — the same
   * no-existence-leak rule `assertCanEdit` follows, but a settings surface a
   * viewer can't even see must look missing, not forbidden); a browser who is
   * not an admin is rejected as NotProjectAdminError (→ 403). One resolve, both
   * checks.
   *
   * ⚠️ NOW AN ALIAS for `assertPermission(…, 'project:administer')` — same
   * signature, same errors, same ordering, so every existing call site behaves
   * identically and none had to change. It SURVIVES the MOTIR-2256 split as the
   * gate on the project-level acts that belong to no domain (rename, key change,
   * archive, alias release); a call site that guards a DOMAIN moves to
   * `assertPermission` with that domain's key, one card at a time.
   */
  async assertCanManage(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    return this.assertPermission(projectId, ctx, 'project:administer', tx);
  },

  // --- The permission model (Story MOTIR-2255 · Subtask MOTIR-2262) ---------
  // The GENERAL read the five `getXCapabilities` methods above are specialised
  // versions of. Each of those grew when a story needed access decisions in a
  // new domain — comments, attachments, watchers, saved filters, settings — and
  // each resolves the same three facts to answer three or four booleans. Once a
  // role is a permission SET, `getPermissions` is the read they all specialise,
  // and the pattern stops needing a sixth sibling.
  //
  // ⚠️ The five are DELIBERATELY left alone by this card. They are called from
  // ~40 places; re-pointing them belongs with the surfaces that consume the set
  // (Story MOTIR-2258), not with the card that introduces it. Their agreement
  // with `getPermissions` is asserted by the story test gate (MOTIR-2264).

  /**
   * The actor's full effective permission SET on a project — one `resolveInputs`
   * round trip, then the pure resolution. The general form of every
   * `getXCapabilities` method above: instead of asking "may I comment?" and "may
   * I moderate?" separately, a caller asks once and tests membership.
   *
   * Throws only ProjectNotFoundError — never a 403-shaped error — for a project
   * that is missing OR in another workspace, preserving the shipped
   * no-existence-leak posture (finding #26).
   */
  async getPermissions(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<ReadonlySet<PermissionKey>> {
    const inputs = await resolveInputs(projectId, ctx, tx);
    return resolvePermissions(inputs);
  },

  /**
   * The actor's own permissions as a serialisable DTO — the set flattened to an
   * array in CATALOG order, which is what crosses to a client island or a Server
   * Component's props. A `Set` cannot; an unsorted array crosses
   * non-deterministically and makes the grid reshuffle for no visible reason.
   */
  async getPermissionsDTO(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<ActorPermissionsDTO> {
    const held = await this.getPermissions(projectId, ctx, tx);
    return toActorPermissionsDTO(projectId, held);
  },

  /**
   * The project's ROLE CATALOG — every role with the permissions it holds and how
   * many people hold it, plus the ROLE-GATED permission rows grouped by domain
   * and their total. This is what the read-only Roles & permissions screens
   * render (Subtask MOTIR-2263), list and detail alike.
   *
   * ⚠️ A PROJECT-SCOPED SERVICE READ, not a static import, even though today's
   * PERMISSION answer is the same for every project. Story MOTIR-2257 makes
   * custom roles project-scoped, at which point that half genuinely depends on
   * which project is asked — and a page wired to a constant would need its data
   * source torn out and replaced exactly then. The member counts are already
   * per-project. It also re-uses the same 404-not-403 gate, so the page cannot
   * confirm a foreign project exists.
   *
   * ⚠️ THE GATE RUNS BEFORE THE COUNT. `resolveInputs` throws
   * ProjectNotFoundError for a project in another workspace, so a cross-tenant id
   * never reaches a membership read at all — the 404 posture is not something the
   * count is allowed to weaken by timing.
   */
  async getRoleCatalog(
    projectId: string,
    ctx: AccessActorContext,
    tx?: Prisma.TransactionClient,
  ): Promise<RoleCatalogDTO> {
    // Resolves for its SIDE EFFECT — the ProjectNotFoundError guard. The
    // permission half is code-owned today; MOTIR-2257 will read the project's own
    // roles here, which is the reason the projectId is threaded at all.
    await resolveInputs(projectId, ctx, tx);
    // ONE grouped read for every role's headcount — never one query per role.
    // Outside a caller-supplied transaction it needs its own workspace context:
    // the project_membership RLS policy reads the per-transaction GUC, so a bare
    // `db` read returns zero rows under the non-bypass app role.
    const counts = tx
      ? await projectMembershipRepository.countByRole(projectId, tx)
      : await withWorkspaceContext(
          { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId },
          (t) => projectMembershipRepository.countByRole(projectId, t),
        );
    return toRoleCatalogDTO(toRoleMemberCounts(counts));
  },
};

/**
 * The repository's grouped rows narrowed to the PROJECT-assignable roles. The
 * `MemberRole` enum is shared with workspace membership and carries `owner`,
 * which a project membership can never hold — dropping it here keeps the mapper
 * total over `ProjectRole` rather than defensive about an enum member that cannot
 * occur. Roles with no members are absent; the mapper zero-fills them.
 */
function toRoleMemberCounts(
  rows: { role: MemberRole; count: number }[],
): Partial<Record<ProjectRole, number>> {
  const counts: Partial<Record<ProjectRole, number>> = {};
  for (const row of rows) {
    const role = asProjectRole(row.role);
    if (role) counts[role] = row.count;
  }
  return counts;
}
