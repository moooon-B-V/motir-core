import type { WorkspaceRole } from '@/generated/prisma/client';

// Workspace membership roles (Story MOTIR-6168 · MOTIR-6457).
//
// Roles live on the workspace (`docs/decisions/role-model.md` §2): each person
// holds ONE role there — Manager · Member · Viewer — or a workspace custom role,
// and it is their role in every project of the workspace. The values are the
// Prisma `WorkspaceRole` enum, stored in `workspace_membership.workspace_role`,
// which is NOT NULL (MOTIR-6561) and the ONLY place a role is read from. This
// file is the single source of the strings so a gate, a migration and a page
// read the same constants.
//
// The LEGACY `workspace_membership.role` column (Story 1.2 · Subtask 1.6.5) is
// still in the schema until the retirement's contract release drops it, and
// NOTHING reads or writes it: the deploy-window fallback that read it
// (`resolveWorkspaceRole`) was deleted by MOTIR-6561, and the writers stopped
// with MOTIR-6562 (the database default fills the column).

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
