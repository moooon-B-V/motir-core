import type { WorkspaceRole } from '@/generated/prisma/client';

// Project + workspace role helpers for the Story 6.4 access model.
//
// A person's ROLE lives on the workspace (Story MOTIR-6168): `WorkspaceRole`,
// read from `workspace_membership.workspace_role`. A project membership carries
// no role at all since MOTIR-6464 — it only says the person is IN the project.
// The legacy `member_role` enum (owner / admin / member / viewer) the two
// membership tables once shared stopped being read (MOTIR-6561) and written
// (MOTIR-6562), and MOTIR-6569 dropped it with the columns.
//
//   * `isWorkspaceManager` — the tier that ALWAYS passes the project-management
//     gate regardless of project membership (the Jira "site admin sees every
//     project" shape).
//   * `PROJECT_ASSIGNABLE_ROLES` / `ProjectRole` — the built-in tier vocabulary
//     the permission sets are keyed by (`lib/permissions/builtinRoles.ts`).
//
// Keeping these as named constants + predicates (not magic strings scattered
// across the service) is the same single-source-of-truth pattern
// lib/workspaces/roles.ts established.

/** Project-assignable roles — `owner` is workspace-only, so it is excluded. */
export const PROJECT_ASSIGNABLE_ROLES = ['admin', 'member', 'viewer'] as const;

export type ProjectRole = (typeof PROJECT_ASSIGNABLE_ROLES)[number];

/**
 * True when `role` is a workspace MANAGER — the tier that always passes the
 * project-management gate regardless of project membership.
 *
 * Roles live on the workspace (Story MOTIR-6168), so the answer is `manager`.
 * Every caller hands it a WORKSPACE role — a membership's stored
 * `workspaceRole`, or the composed role `readReachRole` /
 * `resolveWorkspaceAccess` answer (MOTIR-6462).
 */
export function isWorkspaceManager(role: WorkspaceRole | null | undefined): boolean {
  return role === 'manager';
}

/** Narrow an arbitrary string to a project-assignable `ProjectRole`, or null. */
export function asProjectRole(value: unknown): ProjectRole | null {
  return typeof value === 'string' &&
    (PROJECT_ASSIGNABLE_ROLES as readonly string[]).includes(value)
    ? (value as ProjectRole)
    : null;
}
