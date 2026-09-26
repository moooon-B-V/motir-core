import type { ProjectAccessLevel, WorkspaceRole } from '@/generated/prisma/client';
import { withImpliedPermissions, type PermissionKey } from '@/lib/permissions/catalog';
import {
  PUBLIC_PROJECT_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';

// The permission RESOLUTION (Story MOTIR-2255 · Subtask MOTIR-2261) — the whole
// project access policy, expressed ONCE, as a function from the resolved facts to
// the actor's effective permission SET.
//
// ⚠️ THE ROLE IS THE WORKSPACE'S (Story MOTIR-6168 · MOTIR-6459;
// `docs/decisions/role-model.md` §2–§3). A person's keys in a project are decided
// by their WORKSPACE role — Manager, Member, Viewer or a workspace custom role —
// and by nothing the project stores about them except whether they were ADDED to
// it, which is what the access level reads. No project role and no project custom
// role enters the calculation: changing someone's workspace role changes what they
// can do in every project of the workspace at once. `lib/projects/access.ts` keeps
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
//   2. The always-pass RAIL — a workspace MANAGER holds the entire ROLE-GATED
//      catalog, on every access level, added to the project or not.
//   3. The null-deny RAIL — an actor with no workspace membership holds nothing
//      beyond layer 1. The project gate sits BENEATH the workspace gate.
//
//   …and between the rails, the actor's WORKSPACE ROLE supplies a base set which
//   the ACCESS LEVEL then subtracts from, keyed on whether they were added.
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
  /**
   * The actor's WORKSPACE ROLE, or null if they are not a member of the project's
   * workspace. Read through `resolveWorkspaceRole` (`lib/workspaces/roles.ts`), so
   * a membership the old build wrote during the deploy window resolves by the
   * legacy mapping; the org Owner arrives here as `manager` (MOTIR-6308).
   */
  workspaceRole: WorkspaceRole | null;
  /**
   * The permission array stored on the WORKSPACE custom role the membership
   * holds, or null / absent when it holds a built-in. This is the raw stored
   * array, NOT a validated set — see {@link customRoleBase} for why the filtering
   * happens here.
   *
   * ⚠️ An EMPTY array is not the same as null. A custom role that grants
   * nothing is a legitimate role, and it must resolve to nothing rather than
   * falling back to its tier's set.
   */
  customRolePermissions?: readonly string[] | null;
  /**
   * Whether the actor was ADDED to the project — a `project_membership` row
   * exists. This is the ONE fact a project still holds about a person: it grants
   * nothing by itself, it is what `limited` and `private` read (MOTIR-6169
   * replaces those levels with the access modes).
   */
  addedToProject: boolean;
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
 * The access-level table, keyed on the workspace role and on whether the actor
 * was ADDED to the project (MOTIR-6459):
 *   * `open`    — every workspace member holds their role's keys.
 *   * `limited` — every workspace member holds their role's keys, except
 *                 `work_item:edit`, which needs them to have been added.
 *   * `private` — nobody not added sees it at all; someone added holds their
 *                 role's keys. (A Viewer holds none of the write keys anyway, so
 *                 the old per-project-role split of edit / comment / attachment
 *                 on `private` retired with project roles — the one place a level
 *                 changed meaning.)
 *   * `public`  — anyone on the web reads, no sign-in, ACROSS orgs; workspace
 *                 members keep their role's keys (it behaves like `open` for them
 *                 — making a project public ADDS external read, it does not strip
 *                 its own members' rights).
 */
export function resolvePermissions(i: ProjectPermissionInputs): ReadonlySet<PermissionKey> {
  const held = new Set<PermissionKey>();

  // 1 · Level-gated grants — every actor, anonymous included.
  if (i.accessLevel === 'public') {
    for (const key of PUBLIC_PROJECT_PERMISSIONS) held.add(key);
  }

  // 3 · The null-deny rail — outside the workspace, nothing beyond layer 1.
  if (i.workspaceRole == null) return withImpliedPermissions(held);

  // 2 · The always-pass rail — a Manager holds every role-gated key in every
  // project of their workspace, whatever its level and whether or not they were
  // added. A custom role is never a Manager (it sits at the member tier), so no
  // role somebody authored can narrow a Manager — they cannot lock themselves out.
  if (i.workspaceRole === 'manager') {
    for (const key of ROLE_GATED_PERMISSIONS) held.add(key);
    return withImpliedPermissions(held);
  }

  // Between the rails: the workspace role's base set, minus what the level takes.
  //
  // ⚠️ A CUSTOM ROLE REPLACES THE BASE SET AND NOTHING ELSE. The level-gated layer
  // above means no role can hold or withhold a `public_request:*` key; the rails
  // mean a Manager is never narrowed and a role is never a way INTO a workspace;
  // and `levelGrants` below reads only whether the actor was added — never the
  // role — so A CUSTOM ROLE GRANTS EXACTLY WHAT IT LISTS on every level it can
  // reach. A role that lists `work_item:edit` and silently does not have it would
  // be the bug.
  const base =
    customRoleBase(i.customRolePermissions) ?? WORKSPACE_ROLE_PERMISSIONS[i.workspaceRole];

  for (const key of base) {
    if (!levelGrants(i.accessLevel, key, i.addedToProject)) continue;
    held.add(key);
  }

  // The IMPLICATIONS, applied last (MOTIR-3629). `work_item:delete` confers
  // `work_item:archive`: destroying a subtree irreversibly strictly dominates
  // hiding one row reversibly, so an actor who holds the first and not the second
  // is expressing nothing anyone could have meant. Applying it AFTER the level
  // filter is deliberate and is also a no-op today — `levelGrants` names only
  // `work_item:edit`, so both keys take the same default arm on every level — but
  // the order states which wins if a future
  // branch ever separates them: the level SUBTRACTS from a role, and an
  // implication describes the operations rather than the actor, so it must not
  // hand back a key a level took away. It cannot: `work_item:delete` is subtracted
  // by exactly the levels that subtract `work_item:archive`, so if the implier
  // survived, so did the implied.
  //
  // ⚠️ It reaches a stored CUSTOM ROLE too, via `customRoleBase` above — which is
  // the back-compatibility half: a role authored before the split holds only
  // `work_item:delete`, and its members keep archiving with no migration over
  // the stored custom-role permissions. The EDITOR still shows what the role
  // LISTS; this is what it CONFERS, the same relationship a legacy token scope
  // has to its expansion (`docs/decisions/token-permissions.md` §5, §10).
  //
  // ⚠️ EVERY return of this function is wrapped, including the two rails above
  // where it is provably a no-op today (the manager rail resolves to the whole
  // role-gated catalog, which already lists both keys; the null-deny rail can
  // hold only the level-gated `public_request:*` grants). Wrapping the exit
  // rather than the one branch that needs it is what keeps the property TOTAL:
  // the day a second implication is added, there is no rail it silently misses.
  return withImpliedPermissions(held);
}

/**
 * Whether the project's ACCESS LEVEL lets a workspace member keep `key` from
 * their role's base set — the "subtracts from it" half of the model. It reads ONE
 * fact about the actor, whether they were ADDED to the project, and never their
 * role (MOTIR-6459): the role already chose the base set.
 *
 * ⚠️ Only `work_item:edit` is ever named here. Every other key takes the default
 * arm of its level's branch, so the administrative keys are subtracted by
 * `limited` and `private` exactly as `project:administer` is — proved over the
 * whole input space in `tests/permissions/accessParity.test.ts`. A domain that
 * genuinely needs a different per-level rule is a policy change, and MOTIR-6169
 * replaces this table with the project access modes.
 */
function levelGrants(
  accessLevel: ProjectAccessLevel,
  key: PermissionKey,
  addedToProject: boolean,
): boolean {
  switch (accessLevel) {
    // The most-open rungs: the role's base set survives intact.
    case 'open':
    case 'public':
      return true;
    // Every workspace member keeps their role's keys; only someone added EDITS.
    case 'limited':
      return key === 'work_item:edit' ? addedToProject : true;
    // Invisible to anyone not added; someone added keeps their role's keys.
    case 'private':
      return addedToProject;
  }
}

/** Whether the actor holds `key` on the project — the membership test the predicates call. */
export function hasPermission(i: ProjectPermissionInputs, key: PermissionKey): boolean {
  return resolvePermissions(i).has(key);
}
