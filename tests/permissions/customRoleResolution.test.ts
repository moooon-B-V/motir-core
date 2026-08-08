import type { MemberRole, ProjectAccessLevel } from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';
import { hasPermission, resolvePermissions } from '@/lib/permissions/resolve';
import {
  BUILTIN_ROLE_PERMISSIONS,
  IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import type { PermissionKey } from '@/lib/permissions/catalog';
import type { ProjectAccessInputs } from '@/lib/projects/access';

// The CUSTOM-ROLE RESOLUTION (Story MOTIR-2257 · Subtask MOTIR-2470). One arm in
// `resolvePermissions`: a membership on a custom role resolves THAT role's set
// as its base, instead of its built-in's.
//
// `tests/permissions/accessParity.test.ts` proves the OTHER half and is
// deliberately UNCHANGED by this card — with no custom role in play the answer
// for all 64 actors is byte-identical. This file proves what the new arm adds,
// and — the larger half — what it must NOT disturb:
//
//   * the LEVEL-GATED layer stays above every role;
//   * the workspace-manager RAIL stays above the custom set (an admin cannot be
//     narrowed by a role somebody authored — including one they put themselves
//     on, which is how you would otherwise lock yourself out of your own
//     project's members page);
//   * the null-deny RAIL stays below it (a project role is never a way INTO a
//     workspace);
//   * `levelGrants` is not touched AT ALL, and the truth table below is what
//     proves it did not need to be: a custom role is subtracted by `limited` /
//     `private` at exactly the tier its BASE sits at, because the membership
//     carries `role = definition.basedOn` (the paired-column invariant
//     MOTIR-2467 enforces in the repository).

const ALL_LEVELS: ProjectAccessLevel[] = ['open', 'limited', 'private', 'public'];

/** A membership on a CUSTOM role: `projectRole` is the definition's `basedOn`. */
function onCustomRole(args: {
  accessLevel: ProjectAccessLevel;
  workspaceRole: MemberRole | null;
  basedOn: MemberRole | null;
  permissions: readonly string[];
}): ProjectAccessInputs {
  return {
    accessLevel: args.accessLevel,
    workspaceRole: args.workspaceRole,
    projectRole: args.basedOn,
    customRolePermissions: args.permissions,
  };
}

function sorted(set: ReadonlySet<PermissionKey>): PermissionKey[] {
  return [...set].sort();
}

describe('the custom set REPLACES the base — and only the base', () => {
  it('a membership on a custom role resolves that role`s set, not its base`s', () => {
    // Based on `viewer` (whose set is `project:browse` + `report:view`) but
    // granted two things a viewer does not have.
    const held = resolvePermissions(
      onCustomRole({
        accessLevel: 'open',
        workspaceRole: 'member',
        basedOn: 'viewer',
        permissions: ['project:browse', 'comment:add', 'attachment:create'],
      }),
    );
    expect(sorted(held)).toEqual(['attachment:create', 'comment:add', 'project:browse']);
    // Not the built-in's set — the point of the whole story.
    expect(sorted(held)).not.toEqual(sorted(BUILTIN_ROLE_PERMISSIONS.viewer));
  });

  it('with NO custom role the built-in set is the base, exactly as before', () => {
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const withNull = resolvePermissions({
        accessLevel: 'open',
        workspaceRole: 'member',
        projectRole: role,
        customRolePermissions: null,
      });
      const withAbsent = resolvePermissions({
        accessLevel: 'open',
        workspaceRole: 'member',
        projectRole: role,
      });
      const expected = sorted(BUILTIN_ROLE_PERMISSIONS[role]);
      expect(sorted(withNull)).toEqual(expected);
      expect(sorted(withAbsent)).toEqual(expected);
    }
  });

  it('a workspace member with NO project membership still gets the implicit set', () => {
    const held = resolvePermissions({
      accessLevel: 'open',
      workspaceRole: 'member',
      projectRole: null,
      customRolePermissions: null,
    });
    expect(sorted(held)).toEqual(sorted(IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS));
  });

  it('an EMPTY custom set grants nothing — it does NOT fall back to the base', () => {
    // The distinction that a `?? ` on the array's LENGTH would get wrong. A role
    // that grants nothing is a legitimate role somebody authored on purpose.
    const held = resolvePermissions(
      onCustomRole({
        accessLevel: 'open',
        workspaceRole: 'member',
        basedOn: 'admin',
        permissions: [],
      }),
    );
    expect(sorted(held)).toEqual([]);
    expect(held.size).toBe(0);
  });
});

describe('the two RAILS stay above and below the custom set', () => {
  it('a workspace OWNER resolves the full role-gated catalog even on a near-empty custom role', () => {
    for (const level of ALL_LEVELS) {
      const held = resolvePermissions(
        onCustomRole({
          accessLevel: level,
          workspaceRole: 'owner',
          basedOn: 'viewer',
          permissions: [], // a role that grants nothing at all
        }),
      );
      for (const key of ROLE_GATED_PERMISSIONS) {
        expect(held.has(key), `${level} · owner · ${key}`).toBe(true);
      }
    }
  });

  it('a workspace ADMIN likewise — a role somebody authored can never narrow them', () => {
    const held = resolvePermissions(
      onCustomRole({
        accessLevel: 'private',
        workspaceRole: 'admin',
        basedOn: 'viewer',
        permissions: ['project:browse'],
      }),
    );
    expect(sorted(held)).toEqual(sorted(new Set(ROLE_GATED_PERMISSIONS)));
    // Specifically: they keep the key that lets them FIX a bad role.
    expect(held.has('project:manage_access')).toBe(true);
  });

  it('an actor with NO workspace membership holds nothing beyond the level-gated layer, custom role or not', () => {
    // Non-public: nothing at all.
    const onPrivate = resolvePermissions(
      onCustomRole({
        accessLevel: 'private',
        workspaceRole: null,
        basedOn: 'admin',
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
        basedOn: 'admin',
        permissions: [...ROLE_GATED_PERMISSIONS],
      }),
    );
    expect(sorted(onPublic)).toEqual(
      [
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
        workspaceRole: 'member',
        basedOn: 'admin',
        permissions: ['public_request:submit', 'public_request:upvote', 'public_request:comment'],
      }),
    );
    expect(naming.has('public_request:submit')).toBe(false);

    // …and omitting them does not take them away on a public one.
    const omitting = resolvePermissions(
      onCustomRole({
        accessLevel: 'public',
        workspaceRole: 'member',
        basedOn: 'viewer',
        permissions: ['project:browse'],
      }),
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
        workspaceRole: 'member',
        basedOn: 'viewer',
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
    // Every role-gated key survives the filter; nothing outside it does. Stated
    // over the WHOLE constant so a key joining or leaving it is covered without
    // an edit here.
    const held = resolvePermissions(
      onCustomRole({
        accessLevel: 'open',
        workspaceRole: 'member',
        basedOn: 'admin',
        permissions: [...ROLE_GATED_PERMISSIONS, 'synthetic:not-in-the-catalog'],
      }),
    );
    expect(sorted(held)).toEqual(sorted(new Set(ROLE_GATED_PERMISSIONS)));
    expect(held.has('synthetic:not-in-the-catalog' as PermissionKey)).toBe(false);
  });
});

describe('the ACCESS-LEVEL truth table — a custom role is subtracted at its BASE`s tier', () => {
  // The parity claim this card actually has to make: `levelGrants` was not
  // touched, and did not need to be. A custom role based on `viewer` must be
  // subtracted by `limited` / `private` exactly as `viewer` is, and one based on
  // `member` exactly as `member` is — which holds ONLY because the membership
  // carries `role = definition.basedOn`.
  //
  // ⚠️ The expectations are LITERAL, transcribed from `levelGrants`' three
  // branches by hand — not computed from the code under test, for the same
  // reason accessParity's are not. The permission set is held CONSTANT across
  // both bases so the only variable is the base tier.
  const GRANTED = ['project:browse', 'work_item:edit', 'comment:add', 'attachment:create'] as const;

  type Expectation = Record<(typeof GRANTED)[number], boolean>;

  const TABLE: Array<{
    level: ProjectAccessLevel;
    basedOn: 'viewer' | 'member';
    expected: Expectation;
  }> = [
    // `open` / `public` — the base set survives intact at BOTH tiers.
    {
      level: 'open',
      basedOn: 'viewer',
      expected: {
        'project:browse': true,
        'work_item:edit': true,
        'comment:add': true,
        'attachment:create': true,
      },
    },
    {
      level: 'open',
      basedOn: 'member',
      expected: {
        'project:browse': true,
        'work_item:edit': true,
        'comment:add': true,
        'attachment:create': true,
      },
    },
    {
      level: 'public',
      basedOn: 'viewer',
      expected: {
        'project:browse': true,
        'work_item:edit': true,
        'comment:add': true,
        'attachment:create': true,
      },
    },
    // `limited` — only a project MEMBER edits. A viewer-based role loses
    // `work_item:edit` and keeps the rest; a member-based role keeps everything.
    {
      level: 'limited',
      basedOn: 'viewer',
      expected: {
        'project:browse': true,
        'work_item:edit': false,
        'comment:add': true,
        'attachment:create': true,
      },
    },
    {
      level: 'limited',
      basedOn: 'member',
      expected: {
        'project:browse': true,
        'work_item:edit': true,
        'comment:add': true,
        'attachment:create': true,
      },
    },
    // `private` — a viewer browses and no more; a member keeps all three writes.
    {
      level: 'private',
      basedOn: 'viewer',
      expected: {
        'project:browse': true,
        'work_item:edit': false,
        'comment:add': false,
        'attachment:create': false,
      },
    },
    {
      level: 'private',
      basedOn: 'member',
      expected: {
        'project:browse': true,
        'work_item:edit': true,
        'comment:add': true,
        'attachment:create': true,
      },
    },
  ];

  it.each(TABLE)(
    '$level · a custom role based on $basedOn is subtracted like its base',
    ({ level, basedOn, expected }) => {
      const inputs = onCustomRole({
        accessLevel: level,
        workspaceRole: 'member',
        basedOn,
        permissions: [...GRANTED],
      });
      for (const key of GRANTED) {
        expect(hasPermission(inputs, key), `${level} · ${basedOn} · ${key}`).toBe(expected[key]);
      }
    },
  );

  it('and the SAME subtraction lands on the corresponding BUILT-IN — the parity itself', () => {
    // The claim above is only interesting if the custom answer MATCHES the
    // built-in one for the keys they share. Compare directly, per level.
    for (const level of ALL_LEVELS) {
      for (const basedOn of ['viewer', 'member'] as const) {
        const builtIn = resolvePermissions({
          accessLevel: level,
          workspaceRole: 'member',
          projectRole: basedOn,
        });
        const custom = resolvePermissions(
          onCustomRole({
            accessLevel: level,
            workspaceRole: 'member',
            basedOn,
            // The custom role holds EXACTLY its base's set — so any difference
            // in the resolved answer can only come from the level layer
            // treating the two differently, which is what must not happen.
            permissions: [...BUILTIN_ROLE_PERMISSIONS[basedOn]],
          }),
        );
        expect(sorted(custom), `${level} · ${basedOn}`).toEqual(sorted(builtIn));
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
    expect(source).toMatch(/import type \{ MemberRole, ProjectAccessLevel \}/);
  });
});
