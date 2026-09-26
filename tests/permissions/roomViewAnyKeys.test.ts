import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLE_PERMISSIONS,
  PUBLIC_PROJECT_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import {
  PERMISSION_CATALOG,
  PERMISSIONS,
  PERMISSION_DOMAINS,
  type PermissionKey,
} from '@/lib/permissions/catalog';

// The three rooms' VIEW-ANY keys (Story MOTIR-6179 · MOTIR-6328), assigned by
// `docs/decisions/member-facing-permissions.md` AMENDMENT 1 from the DECISION
// card MOTIR-6165 (Q2, 2026-09-24): every built-in role that browses holds every
// view-any key, so Plans, Approvals and Runs open on the whole project.
//
// The sets are written out rather than derived from the constants under test,
// for the reason `accessParity.test.ts` gives: a derived expectation proves only
// that a constant equals itself.

const ROOM_VIEW_KEYS: readonly PermissionKey[] = [
  'approval:view_any',
  'plan:view_any',
  'run:view_any',
];

/** Keys that let an actor AUTHOR, DECIDE or WRITE — none of which a view key may carry in. */
const ACTING_KEYS: readonly PermissionKey[] = [
  'ai:plan',
  'ai:view_plan',
  'ai:decide_plan',
  'approval:decide_any',
  'work_item:edit',
];

describe('the catalog names the two new view keys', () => {
  it.each(['plan:view_any', 'run:view_any'] as const)(
    '%s is a catalog key in its own domain',
    (key) => {
      expect(PERMISSIONS).toContain(key);
      const descriptor = PERMISSION_CATALOG[key];
      expect(descriptor.domain).toBe(key.split(':')[0]);
      expect(descriptor.labelKey).toBe(`permissions.${key.replace(':', '_')}.label`);
    },
  );

  it('places the plan and run domains immediately after approval, so the three rooms group together', () => {
    const at = PERMISSION_DOMAINS.indexOf('approval');
    expect(PERMISSION_DOMAINS.slice(at, at + 3)).toEqual(['approval', 'plan', 'run']);
  });

  it('keeps `ai:view_plan` as its own key — the view key is a split, not a rename', () => {
    expect(PERMISSIONS).toContain('ai:view_plan');
    expect(PERMISSION_CATALOG['ai:view_plan'].domain).toBe('ai');
  });
});

describe('every built-in role that browses holds the three view-any keys', () => {
  it('the role-gated set carries all three, so admin (the whole set) holds them', () => {
    for (const key of ROOM_VIEW_KEYS) {
      expect(ROLE_GATED_PERMISSIONS, key).toContain(key);
      expect(BUILTIN_ROLE_PERMISSIONS.admin.has(key), `admin lacks ${key}`).toBe(true);
    }
  });

  it('member holds all three and every key it held before', () => {
    expect([...BUILTIN_ROLE_PERMISSIONS.member].sort()).toEqual(
      [
        'project:browse',
        'work_item:edit',
        'work_item:archive',
        'comment:add',
        'attachment:create',
        'sprint:manage',
        'report:view',
        'saved_filter:manage',
        'work_item:triage',
        'ai:plan',
        'ai:view_plan',
        'ai:decide_plan',
        ...ROOM_VIEW_KEYS,
      ].sort(),
    );
  });

  it('viewer is EXACTLY browse, reports and the three view-any keys', () => {
    expect([...BUILTIN_ROLE_PERMISSIONS.viewer].sort()).toEqual(
      ['project:browse', 'report:view', ...ROOM_VIEW_KEYS].sort(),
    );
  });

  it('viewer gains NO key that authors, decides or writes', () => {
    for (const key of ACTING_KEYS) {
      expect(BUILTIN_ROLE_PERMISSIONS.viewer.has(key), `viewer holds ${key}`).toBe(false);
    }
  });
});

describe('the implicit grant gains exactly the Plans and Runs view keys', () => {
  // The implicit WORKSPACE-member set this block also covered retired with
  // project roles (MOTIR-6459): every workspace member now holds a workspace
  // role, and all three built-ins carry all three view-any keys (above).
  it('the public level gains plan:view_any and run:view_any — not approval:view_any', () => {
    expect([...PUBLIC_PROJECT_PERMISSIONS].sort()).toEqual(
      [
        'project:browse',
        'plan:view_any',
        'run:view_any',
        'public_request:submit',
        'public_request:upvote',
        'public_request:comment',
      ].sort(),
    );
  });
});
