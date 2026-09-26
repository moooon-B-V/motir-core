import { describe, expect, it } from 'vitest';
import { APPROVAL_GATE_HANDLERS } from '@/lib/approvalGates/registry';
import { APPROVAL_ACT_PERMISSIONS, canActOnApprovals } from '@/lib/approvalGates/actPermissions';
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';

// Story MOTIR-6179 · MOTIR-6333 — who can ACT in the Approvals room, stated once.
// The constant is a leaf literal (the nav map is read by client bundles); this is
// what keeps it equal to what the decide door actually accepts.

describe('APPROVAL_ACT_PERMISSIONS', () => {
  it('is exactly every registered handler’s floor plus approval:decide_any', () => {
    const floors = new Set(Object.values(APPROVAL_GATE_HANDLERS).map((h) => h.permission));
    expect([...APPROVAL_ACT_PERMISSIONS].sort()).toEqual(
      [...new Set([...floors, 'approval:decide_any'])].sort(),
    );
  });

  it('a Member and an admin can act; a Viewer cannot', () => {
    expect(canActOnApprovals(BUILTIN_ROLE_PERMISSIONS.member)).toBe(true);
    expect(canActOnApprovals(BUILTIN_ROLE_PERMISSIONS.admin)).toBe(true);
    expect(canActOnApprovals(BUILTIN_ROLE_PERMISSIONS.viewer)).toBe(false);
  });
});
