import type { MemberRole, ProjectAccessLevel } from '@/generated/prisma/client';
import { isWorkspaceManager } from '@/lib/projects/roles';
import type { PermissionKey } from '@/lib/permissions/catalog';
import {
  BUILTIN_ROLE_PERMISSIONS,
  IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS,
  PUBLIC_PROJECT_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';

// The permission RESOLUTION (Story MOTIR-2255 · Subtask MOTIR-2261) — the whole
// project access policy, expressed ONCE, as a function from the three resolved
// facts to the actor's effective permission SET. `lib/projects/access.ts` keeps
// its eleven named predicates as the public API and answers each of them with a
// membership test against this set.
//
// Pure: no Prisma client, no IO. The IO half (resolving the three facts from the
// database, then asserting) stays in `lib/services/projectAccessService.ts`.
//
// ⚠️ BOTH SHIPPED RAILS LIVE INSIDE THIS FUNCTION, not around it. Before this
// card, "a workspace owner/admin always passes" and "a non-workspace-member never
// does" were repeated at the top of nearly every predicate. Once a role is a set,
// they belong in the one place that BUILDS the set — any special case left
// outside is one Story MOTIR-2257's custom roles would have to remember to
// reproduce, and a forgotten one grants more than intended.
//
// The three layers, in the order they apply:
//
//   1. LEVEL-GATED grants — decided by `accessLevel` alone, for EVERY actor
//      including an anonymous, cross-org one. A `public` project grants
//      `project:browse` plus the three `public_request:*` keys (Story 6.12).
//      These are not in any role set: a role can neither hold nor withhold them.
//   2. The always-pass RAIL — a workspace owner/admin holds the entire
//      ROLE-GATED catalog, on every access level.
//   3. The null-deny RAIL — an actor with no workspace membership holds nothing
//      beyond layer 1. The project gate sits BENEATH the workspace gate.
//
//   …and between the rails, the actor's project ROLE supplies a base set which
//   the ACCESS LEVEL then subtracts from.
//
// ⚠️ Layer 2 grants the role-gated catalog, NOT every key. A workspace owner on a
// `private` project does NOT hold `public_request:submit` — the shipped
// `canSubmitToTriage` is `accessLevel === 'public'` for everyone, so a "full
// catalog" rail would silently widen it. The parity truth table in
// `tests/permissions/accessParity.test.ts` is what holds this honest.

/** The resolved facts the policy decides over (no IO — see projectAccessService). */
export interface ProjectPermissionInputs {
  /** The project's `accessLevel` (open / limited / private / public). */
  accessLevel: ProjectAccessLevel;
  /** The actor's WORKSPACE membership role, or null if they're not a member. */
  workspaceRole: MemberRole | null;
  /** The actor's PROJECT membership role, or null if they hold no project membership. */
  projectRole: MemberRole | null;
}

/**
 * The actor's effective permission set for the project.
 *
 * The access-level table this reproduces, unchanged from Story 6.4 / 6.12:
 *   * `open`    — any workspace member views + edits.
 *   * `limited` — any workspace member views + comments; only project members
 *                 (member/admin) edit.
 *   * `private` — only project members can see it at all; a `viewer` sees but
 *                 never edits or comments.
 *   * `public`  — anyone on the web reads, no sign-in, ACROSS orgs; internal
 *                 workspace members keep their normal capabilities (it behaves
 *                 like `open` for them — making a project public ADDS external
 *                 read, it does not strip its own members' rights).
 */
export function resolvePermissions(i: ProjectPermissionInputs): ReadonlySet<PermissionKey> {
  const held = new Set<PermissionKey>();

  // 1 · Level-gated grants — every actor, anonymous included.
  if (i.accessLevel === 'public') {
    for (const key of PUBLIC_PROJECT_PERMISSIONS) held.add(key);
  }

  // 2 · The always-pass rail — the "site admin sees + manages every project" tier.
  if (isWorkspaceManager(i.workspaceRole)) {
    for (const key of ROLE_GATED_PERMISSIONS) held.add(key);
    return held;
  }

  // 3 · The null-deny rail — outside the workspace, nothing beyond layer 1.
  if (i.workspaceRole == null) return held;

  // Between the rails: the project role's base set, minus what the level takes.
  const projectRole = i.projectRole;
  const base =
    projectRole === 'admin' || projectRole === 'member' || projectRole === 'viewer'
      ? BUILTIN_ROLE_PERMISSIONS[projectRole]
      : IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS;
  const isProjectMember = projectRole === 'admin' || projectRole === 'member';

  for (const key of base) {
    if (!levelGrants(i.accessLevel, key, projectRole != null, isProjectMember)) continue;
    held.add(key);
  }

  return held;
}

/**
 * Whether the project's ACCESS LEVEL lets a workspace member keep `key` from
 * their role's base set. This is the "subtracts from it" half of the model —
 * every branch transcribed from the shipped per-level tables in
 * `lib/projects/access.ts`.
 *
 * ⚠️ DELIBERATELY UNCHANGED BY MOTIR-2256, and that is what makes the split
 * behaviour-neutral. Only three keys are ever named here — `work_item:edit`,
 * `comment:add`, `attachment:create`. Every other key takes the default arm of
 * its level's branch, so the twelve new administrative keys are subtracted by
 * `limited` and `private` in EXACTLY the way `project:administer` already was:
 * kept on `open` / `public`, kept on `limited` (the `work_item:edit` test does
 * not match them), and on `private` gated on `hasProjectMembership` alone. Since
 * `BUILTIN_ROLE_PERMISSIONS` grants the twelve to precisely the role that already
 * held `project:administer` (admin), the resolved answer is identical for all 64
 * actors — proved in `tests/permissions/accessParity.test.ts`. Adding a branch
 * for one of the twelve here would BREAK that equivalence, so don't; a domain
 * that genuinely needs a different per-level rule is a policy change and belongs
 * in a card that argues for it.
 */
function levelGrants(
  accessLevel: ProjectAccessLevel,
  key: PermissionKey,
  hasProjectMembership: boolean,
  isProjectMember: boolean,
): boolean {
  switch (accessLevel) {
    // The most-open rungs: the role's base set survives intact.
    case 'open':
    case 'public':
      return true;
    // View + comment for any workspace member; only project members EDIT.
    case 'limited':
      return key === 'work_item:edit' ? isProjectMember : true;
    // Invisible without a project membership; a `viewer` browses but no more
    // (their base set is `project:browse` alone, so nothing else can survive).
    case 'private':
      if (!hasProjectMembership) return false;
      return key === 'work_item:edit' || key === 'comment:add' || key === 'attachment:create'
        ? isProjectMember
        : true;
  }
}

/** Whether the actor holds `key` on the project — the membership test the predicates call. */
export function hasPermission(i: ProjectPermissionInputs, key: PermissionKey): boolean {
  return resolvePermissions(i).has(key);
}
