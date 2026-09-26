import type {
  ProjectAccessMode,
  WorkspaceAccessScope,
  WorkspaceRole,
} from '@/generated/prisma/client';
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
// ⚠️ ENTRY IS ONE RULE WITH ONE HOME (Story MOTIR-6169 · MOTIR-6543;
// `role-model.md` Q1). Who may ENTER a project is decided by {@link canEnter} —
// the project's ACCESS MODE, the person's membership SCOPE, whether they were
// ADDED, and the Manager rail — and nothing else. A person who can enter holds
// exactly their workspace role's keys; the per-level subtraction that used to
// thin a role on `limited` / `private` is gone.
//
// The layers, in the order they apply:
//
//   1. MODE-GATED grants — decided by `accessMode` alone, for EVERY actor
//      including an anonymous, cross-org one. A `public` project grants
//      `project:browse` plus the three `public_request:*` keys (Story 6.12).
//      These are not in any role set: a role can neither hold nor withhold them.
//   2. ENTRY — an actor who cannot enter (no workspace membership; or a
//      Members-only project they were not added to; or a Limited scope and not
//      added) holds nothing beyond layer 1. The project gate sits BENEATH the
//      workspace gate.
//   3. The always-pass RAIL — a workspace MANAGER holds the entire ROLE-GATED
//      catalog in every project of their workspace, whatever its mode.
//
//   …and otherwise the entrant holds their WORKSPACE ROLE's set, untouched.
//
// ⚠️ Layer 2 grants the role-gated catalog, NOT every key. A workspace owner on a
// `private` project does NOT hold `public_request:submit` — the shipped
// `canSubmitToTriage` is `accessMode === 'public'` for everyone, so a "full
// catalog" rail would silently widen it. The parity truth table in
// `tests/permissions/accessParity.test.ts` is what holds this honest.

/** The resolved facts the policy decides over (no IO — see projectAccessService). */
export interface ProjectPermissionInputs {
  /**
   * The project's ACCESS MODE (workspace / members / public) — read through
   * `accessModeOf` (`lib/projects/accessMode.ts`), so a project the migration has
   * not reached resolves exactly as its mapped legacy level.
   */
  accessMode: ProjectAccessMode;
  /**
   * The actor's WORKSPACE ROLE, or null if they are not a member of the project's
   * workspace. Read through `resolveWorkspaceRole` (`lib/workspaces/roles.ts`), so
   * a membership the old build wrote during the deploy window resolves by the
   * legacy mapping; the org Owner arrives here as `manager` (MOTIR-6308).
   */
  workspaceRole: WorkspaceRole | null;
  /**
   * The actor's workspace membership ACCESS SCOPE (full / limited), or null when
   * they have no membership in the project's workspace (Story MOTIR-6169). Never
   * read for a Manager, who enters every project.
   */
  accessScope: WorkspaceAccessScope | null;
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
   * nothing by itself, it is what {@link canEnter} reads for a Members-only
   * project and a Limited scope.
   */
  addedToProject: boolean;
  /**
   * Whether the project's ORGANIZATION is closing — scheduled for deletion and
   * inside its 30-day window (Story MOTIR-6306 · MOTIR-6396;
   * `docs/decisions/organization-deletion.md` §3). When true the resolved set is
   * narrowed to {@link CLOSING_READ_SET}: every actor, the Owner included, reads
   * and does nothing else.
   *
   * Optional for the reason `customRolePermissions` is: absent is identical to
   * false, so every existing caller and every truth-table row is untouched.
   * `projectAccessService`'s resolution is the one place that reads the org and
   * sets it.
   */
  organizationClosing?: boolean;
}

/**
 * What a closing organization leaves ANY actor: the `viewer` role's set — the
 * product's own definition of read-only (`builtinRoles.ts`: *"READ-ONLY
 * EVERYWHERE"*). Derived, not hand-listed, so a write key added to the catalog
 * later is closed during the window by default rather than by somebody
 * remembering to add it here.
 */
export const CLOSING_READ_SET: ReadonlySet<PermissionKey> = new Set<PermissionKey>(
  WORKSPACE_ROLE_PERMISSIONS.viewer,
);

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
 * Whether the actor may ENTER the project (Story MOTIR-6169 · MOTIR-6543) —
 * `role-model.md` *Project access modes* / *Membership scopes*:
 *
 * | actor                                    | `members` | `workspace` | `public` |
 * | ---------------------------------------- | --------- | ----------- | -------- |
 * | Manager (incl. org Owner / Admin)        | enters    | enters      | enters   |
 * | added to the project                     | enters    | enters      | enters   |
 * | Full scope, not added                    | —         | enters      | enters   |
 * | Limited scope, not added                 | —         | —           | —        |
 * | no workspace membership                  | —         | —           | —        |
 *
 * A non-entrant on a `public` project still holds the public read set (layer 1
 * of {@link resolvePermissions}) — which is why LISTINGS ask `canEnter` and not
 * `canBrowse`: a Limited person never sees a Public project they were not added
 * to in their own lists, while its link still behaves as a Visitor's.
 */
export function canEnter(
  i: Pick<
    ProjectPermissionInputs,
    'accessMode' | 'workspaceRole' | 'accessScope' | 'addedToProject'
  >,
): boolean {
  if (i.workspaceRole == null) return false;
  if (i.workspaceRole === 'manager') return true;
  if (i.addedToProject) return true;
  if (i.accessMode === 'members') return false;
  return i.accessScope === 'full';
}

/**
 * The actor's effective permission set for the project: the public read set on
 * a `public` project, plus — for an actor who can ENTER ({@link canEnter}) — the
 * Manager rail or their workspace role's set, with nothing subtracted.
 */
export function resolvePermissions(i: ProjectPermissionInputs): ReadonlySet<PermissionKey> {
  const held = resolveOpen(i);
  if (!i.organizationClosing) return held;
  // ⚠️ AN INTERSECTION, NEVER A REPLACEMENT (MOTIR-6396). A closing org takes
  // away; it never hands out. Replacing the set with the viewer set would GRANT
  // `project:browse` to an actor who could not see a private project, which is
  // the one direction this must not move. Nothing is written either: cancel
  // clears `closingSince` and the next request resolves exactly as before.
  const narrowed = new Set<PermissionKey>();
  for (const key of held) if (CLOSING_READ_SET.has(key)) narrowed.add(key);
  return narrowed;
}

/** The actor's set with the organization open — the whole policy described above. */
function resolveOpen(i: ProjectPermissionInputs): ReadonlySet<PermissionKey> {
  const held = new Set<PermissionKey>();

  // 1 · Mode-gated grants — every actor, anonymous included.
  if (i.accessMode === 'public') {
    for (const key of PUBLIC_PROJECT_PERMISSIONS) held.add(key);
  }

  // 2 · Entry — an actor who cannot enter holds nothing beyond layer 1. This
  // covers the null-deny rail (no workspace membership) as its first case.
  const role = i.workspaceRole;
  if (role == null || !canEnter(i)) return withImpliedPermissions(held);

  // 3 · The always-pass rail — a Manager holds every role-gated key in every
  // project of their workspace, whatever its mode. A custom role is never a
  // Manager (it sits at the member tier), so no role somebody authored can
  // narrow a Manager — they cannot lock themselves out.
  if (role === 'manager') {
    for (const key of ROLE_GATED_PERMISSIONS) held.add(key);
    return withImpliedPermissions(held);
  }

  // An entrant holds their workspace role's set, whole.
  //
  // ⚠️ A CUSTOM ROLE REPLACES THE BASE SET AND NOTHING ELSE. The mode-gated layer
  // above means no role can hold or withhold a `public_request:*` key; entry and
  // the rail mean a Manager is never narrowed and a role is never a way INTO a
  // project; so A CUSTOM ROLE GRANTS EXACTLY WHAT IT LISTS in every project its
  // holder can enter.
  const base = customRoleBase(i.customRolePermissions) ?? WORKSPACE_ROLE_PERMISSIONS[role];
  for (const key of base) held.add(key);

  // The IMPLICATIONS, applied last (MOTIR-3629). `work_item:delete` confers
  // `work_item:archive`: destroying a subtree irreversibly strictly dominates
  // hiding one row reversibly, so an actor who holds the first and not the second
  // is expressing nothing anyone could have meant.
  //
  // ⚠️ It reaches a stored CUSTOM ROLE too, via `customRoleBase` above — which is
  // the back-compatibility half: a role authored before the split holds only
  // `work_item:delete`, and its members keep archiving with no migration over
  // the stored custom-role permissions. The EDITOR still shows what the role
  // LISTS; this is what it CONFERS, the same relationship a legacy token scope
  // has to its expansion (`docs/decisions/token-permissions.md` §5, §10).
  //
  // ⚠️ EVERY return of this function is wrapped, including the two early ones
  // where it is provably a no-op today (the manager rail resolves to the whole
  // role-gated catalog, which already lists both keys; a non-entrant can hold
  // only the mode-gated `public_request:*` grants). Wrapping the exit rather than
  // the one branch that needs it is what keeps the property TOTAL: the day a
  // second implication is added, there is no exit it silently misses.
  return withImpliedPermissions(held);
}

/** Whether the actor holds `key` on the project — the membership test the predicates call. */
export function hasPermission(i: ProjectPermissionInputs, key: PermissionKey): boolean {
  return resolvePermissions(i).has(key);
}
