import { hasPermission } from '@/lib/permissions/resolve';
import type { ProjectPermissionInputs } from '@/lib/permissions/resolve';

// The project access POLICY — the eleven NAMED PREDICATES the product asks its
// access questions through. Roughly 150 `assertCan*` call sites across `lib` and
// `app` depend on these names, so they are the stable public API of the model.
//
// ⚠️ THE DECISION TABLE NO LONGER LIVES HERE (Story MOTIR-2255 · Subtask
// MOTIR-2261). Each predicate is now a membership test against the actor's
// resolved PERMISSION SET: `lib/permissions/catalog.ts` names the permissions,
// `lib/permissions/builtinRoles.ts` expresses each built-in role as a set over
// them, and `lib/permissions/resolve.ts` turns the three resolved facts into the
// actor's effective set — including both shipped rails (workspace owner/admin
// always passes; a non-workspace-member never does) and the per-level
// subtraction. Read those three files for the semantics; this file is the
// vocabulary the rest of the codebase speaks.
//
// The move is deliberately BEHAVIOUR-NEUTRAL — the built-in role sets are
// defined as exactly the sets that reproduce the previous decision tables, and
// `tests/permissions/accessParity.test.ts` drives all 64 combinations of access
// level × workspace role × project role through all eleven predicates against
// expectations transcribed as literal booleans from the pre-change policy.
//
// Still pure (no Prisma client, no IO), so it stays trivially unit-testable and
// importable from anywhere; the IO half (resolving the inputs from the DB, then
// asserting) lives in `lib/services/projectAccessService.ts`.
//
// ⚠️ "PERMISSION", NOT "SCOPE" — an API-token scope (`lib/mcp/scopes.ts`) is a
// separate axis that NARROWS its owner's role. The two vocabularies stay
// distinct.

/**
 * The resolved facts the policy decides over (no IO — see projectAccessService).
 * The canonical definition now lives with the resolution in
 * `lib/permissions/resolve.ts`; the name is preserved here because it is the one
 * the call sites import.
 */
export type ProjectAccessInputs = ProjectPermissionInputs;

/**
 * Whether the actor may BROWSE (view) the project — its read paths (the project
 * read, the board projection, the issue list/detail). `public` admits ANYONE,
 * including an unauthenticated / cross-org actor — the single cross-org read
 * exception (Story 6.12); `open`/`limited` admit any workspace member; `private`
 * requires an explicit project membership. Workspace owner/admin always pass.
 */
export function canBrowse(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'project:browse');
}

/**
 * Whether the actor may EDIT the project's issues/board (create / move / assign /
 * update). An explicit project `viewer` is read-only everywhere; on `limited` and
 * `private` only project members (member/admin) edit. Every EXTERNAL / anonymous
 * public viewer is denied by the null-deny rail, so a public viewer NEVER edits —
 * their only writes are the three explicit grants below (Story 6.12 ADR §3).
 */
export function canEdit(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'work_item:edit');
}

/**
 * Whether the actor may COMMENT on the project's issues (Story 5.1 — Jira's
 * "Add comments" permission). Sits BETWEEN browse and edit: on `limited` any
 * workspace member comments even though only project members edit; the explicit
 * read-only `viewer` project role never comments.
 */
export function canComment(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'comment:add');
}

// --- Public-project write grants (Story 6.12 · Subtask 6.12.3) --------------
// The THREE — and only three — writes a PUBLIC-project viewer may perform. Each
// decides over `accessLevel` ALONE and is INDEPENDENT of `canEdit`: a public
// viewer is a non-member, so `canEdit` is false for every normal write, and
// admitting these three is the whole point (ADR §3). In the permission model
// they are LEVEL-GATED — held by every actor on a `public` project and by NO
// actor otherwise, a workspace owner on a private project included — which is
// why no role set contains them.
//
// AUTHENTICATION is enforced UPSTREAM, not here: READ on a public project is
// anonymous, but every WRITE is sign-in-to-act (the 2026-06-14 model), so the
// route requires a session and the service resolves a real account BEFORE these
// predicates are consulted. No OTHER write path may ever key off "is on a public
// project" — a future public-viewer write gets its OWN catalog key and its own
// named predicate, never a relaxation of an existing edit/comment gate.

/**
 * Whether the actor may SUBMIT a bug / feature request into the project's triage
 * (6.12.5) — true iff the project is `public`. Independent of `canEdit`;
 * authentication enforced upstream. The created item is born in the SAME 6.11
 * triage queue.
 */
export function canSubmitToTriage(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'public_request:submit');
}

/**
 * Whether the actor may UPVOTE a public request (6.12.6) — true iff the project
 * is `public`. The vote is one-per-account (server-enforced by the
 * `PublicRequestVote` unique); its count is the demand signal the 6.11.3 triage
 * queue sorts by.
 */
export function canUpvotePublicRequest(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'public_request:upvote');
}

/**
 * Whether the actor may COMMENT on a public request (6.12.6) — true iff the
 * project is `public`. These public-REQUEST comments are public-visible
 * (distinct from a work item's INTERNAL comments, which the 6.12.4 public
 * projection hides).
 */
export function canCommentPublicRequest(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'public_request:comment');
}

/**
 * Whether the actor may MODERATE comments — Jira's "Edit all / Delete all
 * comments" permissions (Story 5.1): the project `admin` tier, plus the
 * workspace owner/admin always-pass rail. Authors edit/delete their OWN
 * comments regardless of this (the service checks authorship first).
 */
export function canModerateComments(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'comment:moderate');
}

/**
 * Whether the actor may ADD attachments — Jira's "Create attachments"
 * permission (Story 5.2 · Subtask 5.2.2). The Story 5.2 contract maps it onto
 * exactly the comment tiers, and until MOTIR-2261 this was literally a
 * re-export of {@link canComment}. It is now a real lookup on its OWN catalog
 * key: the two are distinct permissions in the mirror product, and holding them
 * separately is what lets a custom role (Story MOTIR-2257) grant one without the
 * other — with no call-site change on the day they diverge.
 */
export function canCreateAttachments(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'attachment:create');
}

/**
 * Whether the actor may DELETE ANY attachment — Jira's "Delete all attachments"
 * permission (Story 5.2 · Subtask 5.2.2): project admin + workspace owner/admin.
 * Was a re-export of {@link canModerateComments}; now its own catalog key, for
 * the same reason as {@link canCreateAttachments}. Uploaders delete their OWN
 * regardless (Jira's "Delete own" — the service checks uploadership first).
 */
export function canDeleteAllAttachments(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'attachment:delete_any');
}

/**
 * Whether the actor may MANAGE WATCHERS — Jira's "Manage watchers" permission
 * (Story 5.4): add/remove OTHER users to an issue's watcher list. Same tier as
 * comment moderation, kept as its own permission so the two can diverge the way
 * Jira's scheme allows. Watching YOURSELF needs only browse (watching is not
 * editing — even a `viewer` may watch), so the self paths never consult this.
 */
export function canManageWatchers(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'watcher:manage');
}

/**
 * Whether the actor may ADMINISTER the project — the "manage project" tier Jira
 * gates project settings on (members/roles/access in Story 6.4, the automation
 * rules of Story 6.6). The project `admin` role, plus the workspace owner/admin
 * always-pass rail; a plain member or `viewer` never qualifies.
 *
 * ⚠️ This is ONE umbrella over every administrative domain — members, workflow,
 * board, fields, components, estimation, automation, repositories, AI planning,
 * code access. Splitting it per domain is Story MOTIR-2256's whole job; until
 * then a role holds all of them or none.
 */
export function canManageProject(i: ProjectAccessInputs): boolean {
  return hasPermission(i, 'project:administer');
}
