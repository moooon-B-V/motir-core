import type { MemberRole, ProjectAccessLevel } from '@prisma/client';

// Project + workspace role helpers for the Story 6.4 access model. The
// `MemberRole` enum (owner / admin / member / viewer) is shared by
// `WorkspaceMembership.role` and `ProjectMembership.role` (see schema.prisma),
// but the two scopes use it differently:
//
//   * WORKSPACE scope — `owner` is the founder, `admin` a workspace manager.
//     Both ALWAYS pass the project-management gate regardless of project
//     membership (the Jira "site admin sees every project" shape). This is the
//     `isWorkspaceManager` predicate.
//   * PROJECT scope — a member is added with `admin` / `member` / `viewer`.
//     `owner` is NOT a project-assignable role (a project has no founder; the
//     workspace owner is the always-pass tier above). `PROJECT_ASSIGNABLE_ROLES`
//     is the set the API accepts for add-member / set-role.
//
// Keeping these as named constants + predicates (not magic strings scattered
// across the service) is the same single-source-of-truth pattern
// lib/workspaces/roles.ts established.

/** Project-assignable roles — `owner` is workspace-only, so it is excluded. */
export const PROJECT_ASSIGNABLE_ROLES = ['admin', 'member', 'viewer'] as const;

export type ProjectRole = (typeof PROJECT_ASSIGNABLE_ROLES)[number];

/**
 * The valid `project.accessLevel` values (mirrors the Prisma enum). `public`
 * (Story 6.12) is the openness-ladder top — `public > open > limited > private`
 * — and the only settable level that opens the project for anonymous, cross-org
 * READ. Setting it routes through the SAME `setAccessLevel` service as the other
 * levels (6.12.8 — extend, don't fork); the cross-org browse exception lives in
 * `lib/projects/access.ts` (6.12.3), not here.
 */
export const PROJECT_ACCESS_LEVELS = ['public', 'open', 'limited', 'private'] as const;

/**
 * True when `role` is a workspace manager (owner or admin) — the tier that
 * always passes the project-management gate regardless of project membership.
 */
export function isWorkspaceManager(role: MemberRole | string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Narrow an arbitrary string to a project-assignable `ProjectRole`, or null. */
export function asProjectRole(value: unknown): ProjectRole | null {
  return typeof value === 'string' &&
    (PROJECT_ASSIGNABLE_ROLES as readonly string[]).includes(value)
    ? (value as ProjectRole)
    : null;
}

/** Narrow an arbitrary string to a `ProjectAccessLevel`, or null. */
export function asAccessLevel(value: unknown): ProjectAccessLevel | null {
  return typeof value === 'string' && (PROJECT_ACCESS_LEVELS as readonly string[]).includes(value)
    ? (value as ProjectAccessLevel)
    : null;
}
