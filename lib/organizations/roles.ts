// Organization membership roles (Story 6.10's `organization_membership.role`
// column) — the org-scoped role set, DISTINCT from and sitting ABOVE the
// workspace `WORKSPACE_ROLE` (lib/workspaces/roles.ts):
//   - owner  — the org founder; administers every workspace under the org.
//   - admin  — administers every workspace under the org + org settings/members.
//   - member — org-tier presence only; falls back to its per-workspace role.
//
// This file is the single source of truth for those role strings so the create
// path (workspacesService), the access gate + role precedence (6.10.4), and the
// admin UI (6.10.5) read the same constants instead of scattering magic
// strings. Mirrors lib/workspaces/roles.ts.

import type { OrganizationRole } from '@/generated/prisma/client';

export const ORGANIZATION_ROLE = {
  owner: 'owner',
  admin: 'admin',
  member: 'member',
} as const satisfies Record<string, OrganizationRole>;

export type OrgRole = (typeof ORGANIZATION_ROLE)[keyof typeof ORGANIZATION_ROLE];

/** True when the given role string is the privileged org-owner tier. */
export function isOrgOwnerRole(role: string | null | undefined): boolean {
  return role === ORGANIZATION_ROLE.owner;
}

/**
 * True when the role is ADMIN-EQUIVALENT at the org tier — owner or admin.
 *
 * Lives here rather than beside its first caller (MOTIR-3645) because it is now
 * asked in two services: `organizationsService`'s access gate and
 * `twoFactorPolicyService`'s policy setter. Two copies of "who may administer
 * an organization" is exactly the shape that drifts when a fourth role is added.
 */
export function isOrgAdminRole(role: string | null | undefined): boolean {
  return role === ORGANIZATION_ROLE.owner || role === ORGANIZATION_ROLE.admin;
}
