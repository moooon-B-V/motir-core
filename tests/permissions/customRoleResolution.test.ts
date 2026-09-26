import type { ProjectAccessLevel, WorkspaceRole } from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';
import { hasPermission, resolvePermissions } from '@/lib/permissions/resolve';
import { ROLE_GATED_PERMISSIONS, WORKSPACE_ROLE_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ProjectAccessInputs } from '@/lib/projects/access';

// The CUSTOM-ROLE RESOLUTION — a WORKSPACE custom role since Story MOTIR-6168 ·
// MOTIR-6459 (it was a project one, Story MOTIR-2257 · Subtask MOTIR-2470). One
// arm in `resolvePermissions`: a membership on a custom role resolves THAT role's
// set as its base, instead of its tier's.
//
// `tests/permissions/accessParity.test.ts` is the truth table for the built-ins.
// This file proves what the custom arm adds, and — the larger half — what it
// must NOT disturb:
//
//   * the LEVEL-GATED layer stays above every role;
//   * the Manager RAIL stays above the custom set (a custom role is never a
//     Manager, so no role somebody authored can narrow one — which is how you
//     would otherwise lock yourself out of your own workspace's Roles page);
//   * the null-deny RAIL stays below it (a role is never a way INTO a workspace);
//   * `levelGrants` reads only whether the actor was ADDED, never the role, so a
//     custom role is subtracted by `limited` / `private` exactly as a built-in is.

const ALL_LEVELS: ProjectAccessLevel[] = ['open', 'limited', 'private', 'public'];

/** A membership on a workspace CUSTOM role — held at the `member` tier. */
function onCustomRole(args: {
  accessLevel: ProjectAccessLevel;
  workspaceRole?: WorkspaceRole | null;
  addedToProject?: boolean;
  permissions: readonly string[];
}): ProjectAccessInputs {
  return {
    accessLevel: args.accessLevel,
    workspaceRole: args.workspaceRole === undefined ? 'member' : args.workspaceRole,
    addedToProject: args.addedToProject ?? true,
    customRolePermissions: args.permissions,
  };
}

function sorted(set: ReadonlySet<PermissionKey>): PermissionKey[] {
  return [...set].sort();
}

describe('the custom set REPLACES the base — and only the base', () => {
  it('a membership on a custom role resolves that role`s set, not its tier`s', () => {
    const held = resolvePermissions(
      onCustomRole({
        accessLevel: 'open',
        permissions: ['project:browse', 'comment:add', 'attachment:create'],
      }),
    );
    expect(sorted(held)).toEqual(['attachment:create', 'comment:add', 'project:browse']);
    // Not the tier's set — the point of the whole story.
    expect(sorted(held)).not.toEqual(sorted(WORKSPACE_ROLE_PERMISSIONS.member));
  });

  it('with NO custom role the built-in set is the base, null and absent alike', () => {
    for (const role of ['member', 'viewer'] as const) {
      const withNull = resolvePermissions({
        accessLevel: 'open',
        workspaceRole: role,
        addedToProject: true,
        customRolePermissions: null,
      });
      const withAbsent = resolvePermissions({
        accessLevel: 'open',
        workspaceRole: role,
        addedToProject: true,
      });
      const expected = sorted(WORKSPACE_ROLE_PERMISSIONS[role]);
      expect(sorted(withNull)).toEqual(expected);
      expect(sorted(withAbsent)).toEqual(expected);
    }
  });

  it('a workspace member NEVER ADDED to an open project holds their role`s normal set', () => {
    // The implicit workspace-member set this used to assert retired with project
    // roles (MOTIR-6459): a person has the same role in every project they can
    // enter (`role-model.md`).
    const held = resolvePermissions({
      accessLevel: 'open',
      workspaceRole: 'member',
      addedToProject: false,
      customRolePermissions: null,
    });
    expect(sorted(held)).toEqual(sorted(WORKSPACE_ROLE_PERMISSIONS.member));
  });

  it('an EMPTY custom set grants nothing — it does NOT fall back to the tier', () => {
    // The distinction that a `??` on the array's LENGTH would get wrong. A role
    // that grants nothing is a legitimate role somebody authored on purpose.
    const held = resolvePermissions(onCustomRole({ accessLevel: 'open', permissions: [] }));
    expect(sorted(held)).toEqual([]);
    expect(held.size).toBe(0);
  });
});

describe('the two RAILS stay above and below the custom set', () => {
  it('a Manager resolves the full role-gated catalog on every level, whatever custom array is passed', () => {
    for (const level of ALL_LEVELS) {
      for (const addedToProject of [false, true]) {
        const held = resolvePermissions(
          onCustomRole({
            accessLevel: level,
            workspaceRole: 'manager',
            addedToProject,
            permissions: [], // a role that grants nothing at all
          }),
        );
        for (const key of ROLE_GATED_PERMISSIONS) {
          expect(held.has(key), `${level} · manager · added=${addedToProject} · ${key}`).toBe(true);
        }
      }
    }
    // Specifically: they keep the key that lets them FIX a bad role.
    expect(
      resolvePermissions(
        onCustomRole({ accessLevel: 'private', workspaceRole: 'manager', permissions: [] }),
      ).has('project:manage_access'),
    ).toBe(true);
  });

  it('an actor with NO workspace membership holds nothing beyond the level-gated layer, custom role or not', () => {
    // Non-public: nothing at all.
    const onPrivate = resolvePermissions(
      onCustomRole({
        accessLevel: 'private',
        workspaceRole: null,
        permissions: [...ROLE_GATED_PERMISSIONS],
      }),
    );
    expect(sorted(onPrivate)).toEqual([]);

    // Public: the level-gated grants and NOT ONE key more, even though the
    // custom role names the entire catalog.
    const onPublic = resolvePermissions(
      onCustomRole({
        accessLevel: 'public',
        workspaceRole: null,
        permissions: [...ROLE_GATED_PERMISSIONS],
      }),
    );
    expect(sorted(onPublic)).toEqual(
      [
        // MOTIR-6328 — the two room view keys are level-gated on `public` too.
        'plan:view_any',
        'run:view_any',
        'project:browse',
        'public_request:comment',
        'public_request:submit',
        'public_request:upvote',
      ].sort(),
    );
  });

  it('a custom role can neither HOLD nor WITHHOLD a level-gated `public_request:*` key', () => {
    // Naming them does not grant them on a non-public project…
    const naming = resolvePermissions(
      onCustomRole({
        accessLevel: 'open',
        permissions: ['public_request:submit', 'public_request:upvote', 'public_request:comment'],
      }),
    );
    expect(naming.has('public_request:submit')).toBe(false);

    // …and omitting them does not take them away on a public one.
    const omitting = resolvePermissions(
      onCustomRole({ accessLevel: 'public', permissions: ['project:browse'] }),
    );
    expect(omitting.has('public_request:submit')).toBe(true);
    expect(omitting.has('public_request:upvote')).toBe(true);
    expect(omitting.has('public_request:comment')).toBe(true);
  });
});

describe('the CATALOG is the source of truth over a stored array', () => {
  it('a key that is not in ROLE_GATED_PERMISSIONS is IGNORED, never granted', () => {
    const held = resolvePermissions(
      onCustomRole({
        accessLevel: 'open',
        permissions: [
          'project:browse',
          // A key RETIRED from the catalog after the role was authored — the
          // real shape (`repository:connect`, removed by MOTIR-2294). Stale
          // data may never widen access.
          'repository:connect',
          // Never a key at all.
          'not:a:permission',
          // A level-gated key, which no role may hold.
          'public_request:submit',
        ],
      }),
    );
    expect(sorted(held)).toEqual(['project:browse']);
  });

  it('the filter is derived from the constant, not a hardcoded deny-list', () => {
    const held = resolvePermissions(
      onCustomRole({
        accessLevel: 'open',
        permissions: [...ROLE_GATED_PERMISSIONS, 'synthetic:not-in-the-catalog'],
      }),
    );
    expect(sorted(held)).toEqual(sorted(new Set(ROLE_GATED_PERMISSIONS)));
    expect(held.has('synthetic:not-in-the-catalog' as PermissionKey)).toBe(false);
  });
});

describe('the ACCESS-LEVEL truth table — a custom role is subtracted by whether the actor was ADDED', () => {
  // ⚠️ The expectations are LITERAL, transcribed from `levelGrants`' branches by
  // hand — not computed from the code under test, for the same reason
  // accessParity's are not. The permission set is held CONSTANT, so the only
  // variables are the level and whether the actor was added.
  const GRANTED = ['project:browse', 'work_item:edit', 'comment:add', 'attachment:create'] as const;
  type Expectation = Record<(typeof GRANTED)[number], boolean>;
  const ALL: Expectation = {
    'project:browse': true,
    'work_item:edit': true,
    'comment:add': true,
    'attachment:create': true,
  };
  const NONE: Expectation = {
    'project:browse': false,
    'work_item:edit': false,
    'comment:add': false,
    'attachment:create': false,
  };

  const TABLE: Array<{ level: ProjectAccessLevel; added: boolean; expected: Expectation }> = [
    // `open` / `public` — the set survives intact, added or not.
    { level: 'open', added: false, expected: ALL },
    { level: 'open', added: true, expected: ALL },
    { level: 'public', added: false, expected: ALL },
    { level: 'public', added: true, expected: ALL },
    // `limited` — everything but EDIT for someone not added.
    { level: 'limited', added: false, expected: { ...ALL, 'work_item:edit': false } },
    { level: 'limited', added: true, expected: ALL },
    // `private` — nothing for someone not added; everything for someone added.
    { level: 'private', added: false, expected: NONE },
    { level: 'private', added: true, expected: ALL },
  ];

  it.each(TABLE)('$level · added=$added', ({ level, added, expected }) => {
    const inputs = onCustomRole({
      accessLevel: level,
      addedToProject: added,
      permissions: [...GRANTED],
    });
    for (const key of GRANTED) {
      expect(hasPermission(inputs, key), `${level} · added=${added} · ${key}`).toBe(expected[key]);
    }
  });

  it('and the SAME subtraction lands on the corresponding BUILT-IN — the parity itself', () => {
    // A custom role holding EXACTLY a built-in's set must resolve to exactly what
    // that built-in resolves to, on every level, added or not — any difference
    // could only come from the level layer treating the two differently.
    for (const level of ALL_LEVELS) {
      for (const role of ['viewer', 'member'] as const) {
        for (const addedToProject of [false, true]) {
          const builtIn = resolvePermissions({
            accessLevel: level,
            workspaceRole: role,
            addedToProject,
          });
          const custom = resolvePermissions(
            onCustomRole({
              accessLevel: level,
              addedToProject,
              permissions: [...WORKSPACE_ROLE_PERMISSIONS[role]],
            }),
          );
          expect(sorted(custom), `${level} · ${role} · added=${addedToProject}`).toEqual(
            sorted(builtIn),
          );
        }
      }
    }
  });
});

describe('resolve.ts stays PURE', () => {
  it('imports no Prisma client and performs no IO — proven from the module graph', async () => {
    // Import the module in a bare context and walk what it pulled in. A Prisma
    // import would register `@prisma/client` / the generated client; an IO
    // import would register `node:fs` and friends. The point is not the list —
    // it is that the policy can be reasoned about, and tested, without a
    // database.
    const mod = await import('@/lib/permissions/resolve');
    expect(typeof mod.resolvePermissions).toBe('function');

    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../lib/permissions/resolve.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/from '@\/lib\/db'/);
    expect(source).not.toMatch(/PrismaClient/);
    // The only Prisma reference allowed is the generated TYPE import, which
    // erases at compile time.
    const prismaImports = source.match(/from '@\/generated\/prisma\/client'/g) ?? [];
    expect(prismaImports).toHaveLength(1);
    expect(source).toMatch(/import type \{ ProjectAccessLevel, WorkspaceRole \}/);
  });
});
