import { describe, expect, it } from 'vitest';
import {
  PUBLIC_PROJECT_PERMISSIONS,
  VISITOR_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions/catalog';
import { resolvePermissions } from '@/lib/permissions/resolve';

// The Visitor's key set (Story MOTIR-6170 · MOTIR-6642; `role-model.md` §4):
// the Viewer's, derived — and the public read set is it plus the request grants.

/** A VIEW key: one that reads and never writes, decides or authors. */
const isViewKey = (key: PermissionKey) =>
  key === 'project:browse' || key.endsWith(':view') || key.endsWith(':view_any');

describe('VISITOR_PERMISSIONS', () => {
  it('equals the Viewer set', () => {
    expect([...VISITOR_PERMISSIONS].sort()).toEqual([...WORKSPACE_ROLE_PERMISSIONS.viewer].sort());
  });

  it('holds only catalog VIEW keys, and never ai:view_plan', () => {
    for (const key of VISITOR_PERMISSIONS) {
      expect(PERMISSIONS, key).toContain(key);
      expect(isViewKey(key), `${key} is not a view key`).toBe(true);
    }
    expect(VISITOR_PERMISSIONS.has('ai:view_plan' as PermissionKey)).toBe(false);
  });

  it('holds every room view-any key — the DECISION gives a Visitor every approval record', () => {
    for (const key of ['approval:view_any', 'plan:view_any', 'run:view_any'] as const) {
      expect(VISITOR_PERMISSIONS.has(key), key).toBe(true);
    }
  });
});

describe('PUBLIC_PROJECT_PERMISSIONS', () => {
  it('is the Visitor set plus the three request grants', () => {
    expect([...PUBLIC_PROJECT_PERMISSIONS].sort()).toEqual(
      [
        ...VISITOR_PERMISSIONS,
        'public_request:submit',
        'public_request:upvote',
        'public_request:comment',
      ].sort(),
    );
  });

  it('is exactly what a non-entrant resolves to on a public project', () => {
    for (const actor of [
      { workspaceRole: null, accessScope: null },
      { workspaceRole: 'member' as const, accessScope: 'limited' as const },
    ]) {
      const held = resolvePermissions({
        accessMode: 'public',
        ...actor,
        addedToProject: false,
        organizationClosing: false,
      });
      expect([...held].sort()).toEqual([...PUBLIC_PROJECT_PERMISSIONS].sort());
    }
  });
});
