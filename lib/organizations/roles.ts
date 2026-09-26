// Organization membership roles (Story 6.10's `organization_membership.role`
// column) — the org-scoped role set, DISTINCT from and sitting ABOVE the
// workspace `LEGACY_WORKSPACE_ROLE` (lib/workspaces/roles.ts):
//   - owner  — the one root user; alone deletes or transfers the org.
//   - admin  — runs the org: workspaces, settings, billing, members.
//   - member — org-tier presence only; falls back to its per-workspace role.
//
// WHAT each role may do at the org is `lib/organizations/capabilities.ts`
// (`orgCan`, MOTIR-6305) — ask it rather than comparing role strings.
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
