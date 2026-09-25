import { describe, expect, it } from 'vitest';
import { ORG_CAPABILITY_KEYS, orgCan, type OrgCapability } from '@/lib/organizations/capabilities';
import type { OrgRole } from '@/lib/organizations/roles';

// The org-role capability table (MOTIR-6305), asserted cell by cell against the
// role model (`docs/decisions/role-model.md` §1): the Owner holds everything,
// an Admin everything but deleting and transferring the org, a Member nothing.
const EXPECTED: Record<OrgRole, Record<OrgCapability, boolean>> = {
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

describe('orgCan — the org-role capability table', () => {
  it('exposes exactly the six capabilities of the model', () => {
    expect([...ORG_CAPABILITY_KEYS].sort()).toEqual(
      Object.keys(EXPECTED.owner).sort() as OrgCapability[],
    );
  });

  for (const role of Object.keys(EXPECTED) as OrgRole[]) {
    for (const capability of Object.keys(EXPECTED[role]) as OrgCapability[]) {
      const want = EXPECTED[role][capability];
      it(`${role} ${want ? 'may' : 'may not'} ${capability}`, () => {
        expect(orgCan(role, capability)).toBe(want);
      });
    }
  }

  it('answers false for an absent or unknown role — the safe answer for someone unplaceable', () => {
    for (const capability of ORG_CAPABILITY_KEYS) {
      expect(orgCan(null, capability)).toBe(false);
      expect(orgCan(undefined, capability)).toBe(false);
      expect(orgCan('superadmin', capability)).toBe(false);
      // A prototype key is not a role.
      expect(orgCan('constructor', capability)).toBe(false);
    }
  });
});
