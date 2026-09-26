import type { MemberRole, WorkspaceRole } from '@/generated/prisma/client';

// Workspace membership roles — TWO vocabularies, side by side, for one release.
//
// ── The WORKSPACE ROLE (Story MOTIR-6168 · MOTIR-6457) ──────────────────────
// Roles live on the workspace (`docs/decisions/role-model.md` §2): each person
// holds ONE role there — Manager · Member · Viewer — or a workspace custom role,
// and it is their role in every project of the workspace. The values are the
// Prisma `WorkspaceRole` enum, stored in `workspace_membership.workspace_role`
// beside the legacy column below. This file is the single source of the strings
// so a gate, a migration and a page read the same constants.
//
// ── The LEGACY `workspace_membership.role` (Story 1.2 · Subtask 1.6.5) ───────
// Story 1.2 shipped the column with `member` only; Subtask 1.6.5 promoted the
// workspace CREATOR to `owner` for the jobs dashboard's Replay gate. Those
// exports are renamed `LEGACY_*` here because the new Prisma enum took the name
// `WorkspaceRole`, and they are deleted once every reader has moved to the
// workspace role (MOTIR-6462).

/** The three built-in workspace roles, in the order every surface lists them. */
export const WORKSPACE_ROLES = [
  'manager',
  'member',
  'viewer',
] as const satisfies readonly WorkspaceRole[];

export type { WorkspaceRole };

/**
 * The tier a membership on a workspace CUSTOM role carries in `workspace_role`,
 * beside the `role_definition_id` pointer — the workspace-tier twin of
 * `CUSTOM_ROLE_TIER` in `lib/permissions/builtinRoles.ts`, and `member` for the
 * same reason: the tier exists for the few questions a permission set cannot
 * answer, and an access level's tier subtraction must take nothing away from a
 * role whose set a Manager enumerated by hand. A custom role grants EXACTLY what
 * it lists.
 */
export const CUSTOM_WORKSPACE_ROLE_TIER: WorkspaceRole = 'member';

/**
 * A membership's WORKSPACE ROLE, read through the one place the deploy-window
 * fallback lives (MOTIR-6459): the stored `workspaceRole` when the mapping
 * (MOTIR-6458) has set it, else the legacy `role` mapped by the DECISION's table —
 * `owner` / `admin` → `manager`, `member` → `member`, `viewer` → `viewer`.
 *
 * The fallback is what keeps a row the STILL-SERVING old build writes during the
 * deploy window correct: that build knows nothing of `workspace_role`, so it
 * creates a membership with the column NULL. The follow-up contract story makes
 * the column NOT NULL once no NULL remains and deletes this arm in one place.
 */
export function resolveWorkspaceRole(m: {
  workspaceRole: WorkspaceRole | null;
  role: MemberRole;
}): WorkspaceRole {
  if (m.workspaceRole) return m.workspaceRole;
  return legacyToWorkspaceRole(m.role);
}

/**
 * The stored key array of the workspace CUSTOM role a membership holds — the
 * resolver's `customRolePermissions` input — or null for a built-in. A Manager's
 * is always null: the rail grants them everything, and the org Owner composed in
 * as a Manager (MOTIR-6308) holds no membership to read one from.
 */
export function customRolePermissionsOf(
  workspaceRole: WorkspaceRole | null,
  membership: { roleDefinition: { permissions: string[] } | null } | null,
): readonly string[] | null {
  if (workspaceRole == null || workspaceRole === 'manager') return null;
  return membership?.roleDefinition?.permissions ?? null;
}

/** The DECISION's mapping from a legacy `MemberRole` to a workspace role. */
export function legacyToWorkspaceRole(role: MemberRole): WorkspaceRole {
  switch (role) {
    case 'owner':
    case 'admin':
      return 'manager';
    case 'member':
      return 'member';
    case 'viewer':
      return 'viewer';
  }
}

/** The legacy `workspace_membership.role` strings the Replay gate reads. */
export const LEGACY_WORKSPACE_ROLE = {
  owner: 'owner',
  member: 'member',
} as const;

export type LegacyWorkspaceRole =
  (typeof LEGACY_WORKSPACE_ROLE)[keyof typeof LEGACY_WORKSPACE_ROLE];

/** True when the given LEGACY role string is the privileged workspace-owner tier. */
export function isLegacyOwnerRole(role: string | null | undefined): boolean {
  return role === LEGACY_WORKSPACE_ROLE.owner;
}
