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
  /**
   * The permission array stored on the CUSTOM role this membership holds, or
   * null / absent when the membership names a built-in (Story MOTIR-2257 ·
   * Subtask MOTIR-2470). This is the raw stored array, NOT a validated set —
   * see {@link customRoleBase} for why the filtering happens here.
   *
   * Optional so that every existing caller and every existing truth-table row
   * is untouched: absent is identical to null is identical to "no custom role",
   * which is what keeps `tests/permissions/accessParity.test.ts` green with no
   * edit at all.
   *
   * ⚠️ An EMPTY array is not the same as null. A custom role that grants
   * nothing is a legitimate role, and it must resolve to nothing rather than
   * falling back to its base's set.
   */
  customRolePermissions?: readonly string[] | null;
}

/**
 * `ROLE_GATED_PERMISSIONS` as a Set, built once — the membership test
 * {@link customRoleBase} runs per stored key.
 */
const ROLE_GATED_SET: ReadonlySet<string> = new Set<string>(ROLE_GATED_PERMISSIONS);

/**
 * The base set a stored custom-role array resolves to, or null when there is no
 * custom role in play.
 *
 * ⚠️ THE CATALOG IS THE SOURCE OF TRUTH OVER A STORED ARRAY. A key that is not
 * in `ROLE_GATED_PERMISSIONS` is DROPPED rather than granted — which matters for
 * exactly one case and it is the one that would hurt: a key RETIRED from the
 * catalog after the role was authored (the shape `repository:connect` had when
 * MOTIR-2294 removed it). Such a row is stale data, and stale data may never
 * widen access. The service refuses an out-of-catalog key at WRITE time
 * (MOTIR-2472); this is the read-side half, and it is the half that keeps
 * working when the catalog changes under rows already stored.
 */
function customRoleBase(
  stored: readonly string[] | null | undefined,
): ReadonlySet<PermissionKey> | null {
  if (stored == null) return null;
  const set = new Set<PermissionKey>();
  for (const key of stored) {
    if (ROLE_GATED_SET.has(key)) set.add(key as PermissionKey);
  }
  return set;
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
  //
  // ⚠️ A CUSTOM ROLE REPLACES THE BASE SET AND NOTHING ELSE (MOTIR-2470). It is
  // the only line in this function that moved, and everything above and below it
  // is load-bearing: the level-gated layer above means no role can hold or
  // withhold a `public_request:*` key; the two rails above mean a workspace
  // owner/admin can never be narrowed by a role somebody authored (so an admin
  // cannot lock themselves out) and a project role is never a way INTO a
  // workspace; and `levelGrants` below is not touched at all.
  //
  // `levelGrants` needs no custom-role branch because `projectRole` already
  // carries the custom role's `basedOn` — the paired-column invariant the
  // repository enforces (MOTIR-2467). So a role based on `viewer` is subtracted
  // by `limited` / `private` exactly as `viewer` is, and one based on `member`
  // exactly as `member` is. ADDING a branch there would break that parity, which
  // is the whole reason the two columns move together. Don't.
  const projectRole = i.projectRole;
  const base =
    customRoleBase(i.customRolePermissions) ??
    (projectRole === 'admin' || projectRole === 'member' || projectRole === 'viewer'
      ? BUILTIN_ROLE_PERMISSIONS[projectRole]
      : IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS);
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
