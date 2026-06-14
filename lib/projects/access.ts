import type { MemberRole, ProjectAccessLevel } from '@prisma/client';
import { isWorkspaceManager } from '@/lib/projects/roles';

// The project browse/edit access POLICY (Story 6.4 · Subtask 6.4.3) — a single,
// pure decision function over three inputs. Kept here (no Prisma client, no IO)
// so it is trivially unit-testable and importable from anywhere; the IO half
// (resolving the inputs from the DB, then asserting) lives in
// `lib/services/projectAccessService.ts`.
//
// The model mirrors Jira team-managed projects (decision-authority rung 1):
//   * accessLevel `open`    — any workspace member views + edits.
//   * accessLevel `limited` — any workspace member views + comments; only
//                             project members (member/admin) edit.
//   * accessLevel `private` — only project members (or workspace owner/admin)
//                             can see it at all; viewers see but can't edit.
//   * accessLevel `public`  — (Story 6.12) ANYONE on the web reads, no sign-in,
//                             ACROSS orgs/workspaces; the openness ladder is
//                             public > open > limited > private. `public` is the
//                             ONLY level that crosses the org boundary for READ:
//                             `canBrowse` gains ONE leading branch (below) that
//                             returns true for ANYONE — a null-role / anonymous
//                             actor included. The only public-viewer WRITES are
//                             the three explicit grants (`canSubmitToTriage` /
//                             `canUpvotePublicRequest` / `canCommentPublicRequest`),
//                             never a relaxation of `canEdit`: a public NON-member
//                             (workspaceRole == null) is denied every normal write
//                             by the null-deny rail, exactly as today. An INTERNAL
//                             workspace member of a public project keeps their
//                             normal capabilities — `public` behaves like `open`
//                             in the edit/comment tables (the most-open rung), the
//                             null rail having already removed every external actor.
//                             See docs/decisions/public-projects.md (Subtask 6.12.2).
//
// Two always-pass / always-deny rails frame every level:
//   * A workspace OWNER or ADMIN always passes BOTH browse and edit — the
//     "site admin sees + manages every project" tier (isWorkspaceManager).
//   * A non-workspace-member (workspaceRole == null) always fails BOTH — the
//     project gate sits BENEATH the workspace gate (finding #26), so someone
//     outside the workspace never reaches a project in it.
//
// Between those rails, the per-level table applies. A project role of `viewer`
// is read-only EVERYWHERE (the global "viewer can view + comment, never edit"
// rule), so it is denied edit before the per-level branch.

/** The resolved facts the policy decides over (no IO — see projectAccessService). */
export interface ProjectAccessInputs {
  /** The project's `accessLevel` (open / limited / private / public). */
  accessLevel: ProjectAccessLevel;
  /** The actor's WORKSPACE membership role, or null if they're not a member. */
  workspaceRole: MemberRole | null;
  /** The actor's PROJECT membership role, or null if they hold no project membership. */
  projectRole: MemberRole | null;
}

/**
 * Whether the actor may BROWSE (view) the project — its read paths (the project
 * read, the board projection, the issue list/detail). `public` admits ANYONE —
 * including an unauthenticated / cross-org actor (workspaceRole == projectRole ==
 * null) — the single cross-org read exception (Story 6.12); `open`/`limited`
 * admit any workspace member; `private` requires an explicit project membership.
 * Workspace owner/admin always pass; a non-workspace-member never does (except on
 * a `public` project, caught by the leading branch).
 */
export function canBrowse(i: ProjectAccessInputs): boolean {
  // The ONE cross-org / anonymous public-read exception (Story 6.12 · ADR §2.1):
  // leading + unconditional, so a `public` project is browsable by anyone the
  // policy is asked about — a viewer with workspaceRole == null / projectRole ==
  // null (logged out, cross-org, a crawler) included. No other predicate gains
  // this branch (canEdit/canComment/… are unchanged — Story 6.12 ADR §3).
  if (i.accessLevel === 'public') return true;
  if (isWorkspaceManager(i.workspaceRole)) return true;
  if (i.workspaceRole == null) return false;
  switch (i.accessLevel) {
    case 'open':
    case 'limited':
      return true;
    case 'private':
      return i.projectRole != null;
  }
}

/**
 * Whether the actor may EDIT the project's issues/board (create / move / assign /
 * update). Workspace owner/admin always pass; a non-workspace-member never does;
 * an explicit project `viewer` is read-only everywhere. Then per level:
 *   * `open`    — any workspace member edits.
 *   * `limited` — only project members with role member/admin edit (everyone
 *                 else is view + comment).
 *   * `private` — only project members with role member/admin edit (browse has
 *                 already ensured they're a member; a viewer was denied above).
 *   * `public`  — behaves like `open` for the only actors that reach this switch:
 *                 INTERNAL workspace members (the most-open rung — making a
 *                 project public ADDS external read, it does not strip its own
 *                 members' edit rights). Every EXTERNAL / anonymous public viewer
 *                 (workspaceRole == null) was already denied by the null-deny rail
 *                 above, so a public viewer NEVER edits — their writes are only the
 *                 three explicit grants below, not `canEdit` (Story 6.12 ADR §3).
 */
export function canEdit(i: ProjectAccessInputs): boolean {
  if (isWorkspaceManager(i.workspaceRole)) return true;
  if (i.workspaceRole == null) return false;
  if (i.projectRole === 'viewer') return false;
  switch (i.accessLevel) {
    case 'open':
    case 'public':
      return true;
    case 'limited':
    case 'private':
      return i.projectRole === 'member' || i.projectRole === 'admin';
  }
}

/**
 * Whether the actor may COMMENT on the project's issues (Story 5.1 — Jira's
 * "Add comments" permission mapped onto this role model). Sits BETWEEN browse
 * and edit: on `limited` projects any workspace member comments (the level's
 * "view + comment" contract) even though only project members edit; the
 * explicit read-only `viewer` project role never comments (the shipped viewer
 * contract is read-only — the Story 5.1 decision); `private` requires a
 * non-viewer project membership (browse already implies membership). Workspace
 * owner/admin always pass; a non-workspace-member never does.
 */
export function canComment(i: ProjectAccessInputs): boolean {
  if (isWorkspaceManager(i.workspaceRole)) return true;
  if (i.workspaceRole == null) return false;
  if (i.projectRole === 'viewer') return false;
  switch (i.accessLevel) {
    case 'open':
    case 'limited':
    // `public` behaves like `open`/`limited` for the INTERNAL workspace members
    // that reach this switch (the most-open rung); external / anonymous public
    // viewers were denied by the null-deny rail above. Public-VIEWER commenting
    // is the separate `canCommentPublicRequest` grant on the public REQUEST
    // thread, not this work-item comment gate (Story 6.12 ADR §3/§4).
    case 'public':
      return true;
    case 'private':
      return i.projectRole === 'member' || i.projectRole === 'admin';
  }
}

// --- Public-project write grants (Story 6.12 · Subtask 6.12.3) --------------
// The THREE — and only three — writes a PUBLIC-project viewer may perform:
// submit a request into the triage, upvote an existing request, comment on a
// request. Each is a NEW, narrow, independently-named predicate that decides
// over `accessLevel` ALONE (the project is `public`) and is INDEPENDENT of
// `canEdit` — a public viewer is a non-member, so `canEdit` is false for every
// normal write; admitting these three is the whole point (ADR §3). They do NOT
// consult workspaceRole / projectRole: a member of the project also satisfies
// them (they are authenticated) and keeps their richer internal capabilities
// through the predicates above.
//
// AUTHENTICATION is enforced UPSTREAM, not here: READ on a public project is
// anonymous, but every WRITE is sign-in-to-act (the 2026-06-14 model), so the
// route requires a session and the service resolves a real account BEFORE these
// predicates are consulted. The pure layer never sees a session, so it cannot
// assert "authenticated" — it asserts only "the project is public"; the service
// (`projectAccessService`, which only resolves a public actor through its
// authenticated grant methods) supplies the account. No OTHER write path may
// ever key off "is on a public project" — a future public-viewer write gets its
// OWN named grant here, never a relaxation of an existing edit/comment gate.

/**
 * Whether the actor may SUBMIT a bug / feature request into the project's triage
 * (6.12.5) — true iff the project is `public`. Independent of `canEdit`;
 * authentication enforced upstream (sign-in-to-act). Gates the cross-account
 * submit path; the created item is born in the SAME 6.11 triage queue.
 */
export function canSubmitToTriage(i: ProjectAccessInputs): boolean {
  return i.accessLevel === 'public';
}

/**
 * Whether the actor may UPVOTE a public request (6.12.6) — true iff the project
 * is `public`. Independent of `canEdit`; authentication enforced upstream. The
 * vote is one-per-account (server-enforced by the `PublicRequestVote` unique);
 * its count is the demand signal the 6.11.3 triage queue sorts by.
 */
export function canUpvotePublicRequest(i: ProjectAccessInputs): boolean {
  return i.accessLevel === 'public';
}

/**
 * Whether the actor may COMMENT on a public request (6.12.6) — true iff the
 * project is `public`. Independent of `canEdit`; authentication enforced
 * upstream. These public-REQUEST comments are public-visible (distinct from a
 * work item's INTERNAL comments, which the 6.12.4 public projection hides).
 */
export function canCommentPublicRequest(i: ProjectAccessInputs): boolean {
  return i.accessLevel === 'public';
}

/**
 * Whether the actor may MODERATE comments — Jira's "Edit all / Delete all
 * comments" permissions (Story 5.1): the project `admin` tier, plus the
 * workspace owner/admin always-pass rail. Authors edit/delete their OWN
 * comments regardless of this (the service checks authorship first).
 */
export function canModerateComments(i: ProjectAccessInputs): boolean {
  if (isWorkspaceManager(i.workspaceRole)) return true;
  if (i.workspaceRole == null) return false;
  return i.projectRole === 'admin';
}

/**
 * Whether the actor may ADD attachments — Jira's "Create attachments"
 * permission (Story 5.2 · Subtask 5.2.2). The Story 5.2 contract maps it onto
 * EXACTLY the comment tiers ("admin/member add; read-only viewer neither" —
 * the same 6.4 mapping 5.1 verified for comments), so the policy IS
 * {@link canComment}, re-exported under the attachment name: call sites read
 * as the permission they check, and the two permissions stay independently
 * evolvable (they are distinct permissions in the mirror product) without
 * duplicating the decision table today.
 */
export const canCreateAttachments: (i: ProjectAccessInputs) => boolean = canComment;

/**
 * Whether the actor may DELETE ANY attachment — Jira's "Delete all
 * attachments" permission (Story 5.2 · Subtask 5.2.2): project admin +
 * workspace owner/admin, i.e. exactly the {@link canModerateComments} tiers
 * (the Story 5.2 mapping). Uploaders delete their OWN regardless (Jira's
 * "Delete own" — the service checks uploadership first).
 */
export const canDeleteAllAttachments: (i: ProjectAccessInputs) => boolean = canModerateComments;

/**
 * Whether the actor may MANAGE WATCHERS — Jira's "Manage watchers" permission
 * (Story 5.4): add/remove OTHER users to an issue's watcher list. Same tier as
 * comment moderation — the project `admin` tier plus the workspace owner/admin
 * always-pass rail — but kept as its own named predicate so the two permissions
 * can diverge the way Jira's scheme allows. Watching YOURSELF needs only
 * browse (watching is not editing — the verified split; even a `viewer` may
 * watch), so the self paths never consult this.
 */
export function canManageWatchers(i: ProjectAccessInputs): boolean {
  if (isWorkspaceManager(i.workspaceRole)) return true;
  if (i.workspaceRole == null) return false;
  return i.projectRole === 'admin';
}

/**
 * Whether the actor may ADMINISTER the project — the "manage project" tier
 * Jira gates project settings on (members/roles/access in Story 6.4, and the
 * automation rules of Story 6.6). The project `admin` role, plus the workspace
 * owner/admin always-pass rail; a plain member or `viewer` never qualifies.
 * This is the same decision `projectMembersService.assertCanManage` already
 * enforces inline (add/remove member, set role/access) — lifted here as the
 * shared, unit-testable predicate so every admin-gated settings surface reads
 * the one policy instead of re-deriving it.
 */
export function canManageProject(i: ProjectAccessInputs): boolean {
  if (isWorkspaceManager(i.workspaceRole)) return true;
  if (i.workspaceRole == null) return false;
  return i.projectRole === 'admin';
}
