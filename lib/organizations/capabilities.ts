// WHAT EACH ORGANIZATION ROLE MAY DO — the one table (Story MOTIR-6167 ·
// MOTIR-6305; the model is `docs/decisions/role-model.md` §1, MOTIR-6165).
//
// Before this file, "who may do what at the organization" was answered in every
// file that asked it — `isOrgAdminRole` here, `isOrgOwnerRole` there, a
// hand-rolled `owner || admin` on three settings pages — and the answers had
// started to disagree with the model: billing was owner-only, and nothing
// distinguished the one Owner from an Admin at all. A caller now asks
// `orgCan(role, capability)` and gets the model's answer.
//
// The map is TOTAL over both closed unions, so a fourth role or a seventh
// capability is a compile error until every cell of its row or column is
// written down — the drift `roles.ts` warned about becomes impossible rather
// than merely discouraged.
//
// ⚠️ This is the ORG tier only. What a person may do INSIDE a workspace or
// project is the permission resolver's (`lib/permissions/resolve.ts`); the one
// place the org role reaches down there — the Owner's full rights everywhere,
// and an Admin's reach coming from membership — is MOTIR-6308's, not a row here.

import type { OrgRole } from '@/lib/organizations/roles';

export type OrgCapability =
  /** End the organization. Owner-only; the deletion itself is MOTIR-6306. */
  | 'deleteOrganization'
  /** Hand the Owner role to another member. Owner-only. */
  | 'transferOwnership'
  /** Create and remove workspaces. */
  | 'manageWorkspaces'
  /** The org's name, security (2FA policy), Git connections and usage. */
  | 'manageOrgSettings'
  /** Read AND mutate billing: checkout, the portal, seat quantity. */
  | 'manageBilling'
  /** Invite, change a role between Admin and Member, remove. */
  | 'manageOrgMembers';

const ORG_CAPABILITIES: Record<OrgRole, Record<OrgCapability, boolean>> = {
  owner: {
    deleteOrganization: true,
    transferOwnership: true,
    manageWorkspaces: true,
    manageOrgSettings: true,
    manageBilling: true,
    manageOrgMembers: true,
  },
  admin: {
    deleteOrganization: false,
    transferOwnership: false,
    manageWorkspaces: true,
    manageOrgSettings: true,
    manageBilling: true,
    manageOrgMembers: true,
  },
  member: {
    deleteOrganization: false,
    transferOwnership: false,
    manageWorkspaces: false,
    manageOrgSettings: false,
    manageBilling: false,
    manageOrgMembers: false,
  },
};

/** Every capability, in the table's order — for tests and exhaustive surfaces. */
export const ORG_CAPABILITY_KEYS = Object.keys(ORG_CAPABILITIES.owner) as OrgCapability[];

/**
 * May a holder of `role` perform `capability` at the organization?
 *
 * An absent or unknown role (a non-member, a stale string) answers `false`:
 * the question is asked of a surface or a guard, and the safe answer for
 * "someone we cannot place" is no.
 */
export function orgCan(role: string | null | undefined, capability: OrgCapability): boolean {
  if (role == null || !Object.hasOwn(ORG_CAPABILITIES, role)) return false;
  return ORG_CAPABILITIES[role as OrgRole][capability];
}
