import { describe, expect, it } from 'vitest';
import { isWorkspaceManager } from '@/lib/projects/roles';
import {
  CUSTOM_WORKSPACE_ROLE_TIER,
  customRolePermissionsOf,
  isLegacyOwnerRole,
  legacyToWorkspaceRole,
  resolveWorkspaceRole,
  WORKSPACE_ROLES,
} from '@/lib/workspaces/roles';

// The workspace-role vocabulary (Story MOTIR-6168 · MOTIR-6457 / MOTIR-6459) —
// pure helpers, so unit-tested without a database.

describe('resolveWorkspaceRole — the deploy-window fallback lives in ONE function', () => {
  it('a stored workspace_role wins over the legacy column', () => {
    expect(resolveWorkspaceRole({ workspaceRole: 'viewer', role: 'owner' })).toBe('viewer');
    expect(resolveWorkspaceRole({ workspaceRole: 'manager', role: 'member' })).toBe('manager');
  });

  it('NULL + legacy admin resolves as Manager; NULL + viewer as Viewer', () => {
    expect(resolveWorkspaceRole({ workspaceRole: null, role: 'admin' })).toBe('manager');
    expect(resolveWorkspaceRole({ workspaceRole: null, role: 'viewer' })).toBe('viewer');
  });

  it('the legacy mapping is the DECISION’s table, total over MemberRole', () => {
    expect(legacyToWorkspaceRole('owner')).toBe('manager');
    expect(legacyToWorkspaceRole('admin')).toBe('manager');
    expect(legacyToWorkspaceRole('member')).toBe('member');
    expect(legacyToWorkspaceRole('viewer')).toBe('viewer');
  });
});

describe('isWorkspaceManager — Manager, and the legacy values that map to it', () => {
  it('answers true for manager, owner and admin, and false for everything else', () => {
    for (const role of ['manager', 'owner', 'admin']) expect(isWorkspaceManager(role)).toBe(true);
    for (const role of ['member', 'viewer', null, undefined, 'nonsense']) {
      expect(isWorkspaceManager(role)).toBe(false);
    }
  });
});

describe('customRolePermissionsOf — the resolver’s custom-role input', () => {
  const onRole = { roleDefinition: { permissions: ['project:browse', 'comment:add'] } };

  it('a Member on a custom role hands its stored keys through', () => {
    expect(customRolePermissionsOf('member', onRole)).toEqual(['project:browse', 'comment:add']);
  });

  it('a built-in, no membership, or a Manager hands null', () => {
    expect(customRolePermissionsOf('member', { roleDefinition: null })).toBeNull();
    expect(customRolePermissionsOf('member', null)).toBeNull();
    expect(customRolePermissionsOf(null, onRole)).toBeNull();
    // A Manager is never narrowed by a role — even one a row happens to point at.
    expect(customRolePermissionsOf('manager', onRole)).toBeNull();
  });
});

describe('the constants', () => {
  it('three built-ins, a custom role at the member tier, and the legacy owner predicate', () => {
    expect(WORKSPACE_ROLES).toEqual(['manager', 'member', 'viewer']);
    expect(CUSTOM_WORKSPACE_ROLE_TIER).toBe('member');
    expect(isLegacyOwnerRole('owner')).toBe(true);
    expect(isLegacyOwnerRole('admin')).toBe(false);
  });
});
