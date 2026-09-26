import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectAccessLevel, WorkspaceRole } from '@/generated/prisma/client';
import { describe, expect, it } from 'vitest';
import {
  canBrowse,
  canComment,
  canCommentPublicRequest,
  canCreateAttachments,
  canDeleteAllAttachments,
  canEdit,
  canManageProject,
  canManageWatchers,
  canModerateComments,
  canSubmitToTriage,
  canUpvotePublicRequest,
  type ProjectAccessInputs,
} from '@/lib/projects/access';
import { hasPermission, resolvePermissions } from '@/lib/permissions/resolve';
import {
  PUBLIC_PROJECT_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import type { PermissionKey } from '@/lib/permissions/catalog';

// THE TRUTH TABLE for the project access policy — REWRITTEN by Story MOTIR-6168 ·
// MOTIR-6459, when roles moved to the WORKSPACE (`docs/decisions/role-model.md`
// §2–§3). The old table was 64 rows of access level × workspace role × PROJECT
// role; a project carries no role any more, so its input space is now:
//
//   4 access levels × { no membership, Manager, Member, Viewer, a custom role }
//                   × { added to the project, not added }   =   40 rows
//
// ⚠️ EACH ROW'S EXPECTED SET IS WRITTEN OUT, from the LITERAL key lists below —
// never computed from the code under test. A table computed from `resolve.ts`
// would only prove the code agrees with itself. The literals are the built-in
// sets transcribed by hand; a separate assertion pins that they still equal
// `WORKSPACE_ROLE_PERMISSIONS`, so a change to a role is a deliberate edit HERE.
//
// If a future card intends a behaviour change, the row it changes must be edited
// by hand, deliberately — that friction is the point.

// ── The literal sets ─────────────────────────────────────────────────────────

/** A Manager: the whole role-gated catalog (the old project `admin` set). */
const MANAGER: readonly PermissionKey[] = [
  'ai:configure',
  'ai:decide_plan',
  'ai:plan',
  'ai:view_plan',
  'approval:decide_any',
  'approval:view_any',
  'attachment:create',
  'attachment:delete_any',
  'automation:manage',
  'board:configure',
  'comment:add',
  'comment:moderate',
  'component:manage',
  'estimation:manage',
  'field:manage',
  'import:run',
  'integration:manage',
  'label:manage',
  'lesson:manage',
  'lesson:reinforce',
  'lesson:view',
  'member:manage',
  'plan:view_any',
  'project:administer',
  'project:browse',
  'project:manage_access',
  'report:view',
  'repository:manage',
  'repository:manage_access',
  'run:view_any',
  'saved_filter:manage',
  'saved_filter:manage_any',
  'sprint:manage',
  'watcher:manage',
  'work_item:archive',
  'work_item:delete',
  'work_item:edit',
  'work_item:triage',
  'workflow:manage',
];

/** A Member: the everyday work. */
const MEMBER: readonly PermissionKey[] = [
  'ai:decide_plan',
  'ai:plan',
  'ai:view_plan',
  'approval:view_any',
  'attachment:create',
  'comment:add',
  'plan:view_any',
  'project:browse',
  'report:view',
  'run:view_any',
  'saved_filter:manage',
  'sprint:manage',
  'work_item:archive',
  'work_item:edit',
  'work_item:triage',
];

/** A Viewer: reads, including every room's view-any key. */
const VIEWER: readonly PermissionKey[] = [
  'approval:view_any',
  'plan:view_any',
  'project:browse',
  'report:view',
  'run:view_any',
];

/**
 * A workspace CUSTOM role — "Reviewer", the story's verification role: a Viewer
 * base plus commenting, WITHOUT the runs view key. Resolved exactly as listed.
 */
const CUSTOM: readonly PermissionKey[] = [
  'approval:view_any',
  'comment:add',
  'plan:view_any',
  'project:browse',
  'report:view',
];

/** What a `public` project grants every actor, anonymous included. */
const PUBLIC: readonly PermissionKey[] = [
  'plan:view_any',
  'project:browse',
  'public_request:comment',
  'public_request:submit',
  'public_request:upvote',
  'run:view_any',
];

const NONE: readonly PermissionKey[] = [];

const union = (...sets: (readonly PermissionKey[])[]): PermissionKey[] =>
  [...new Set(sets.flat())].sort();
const without = (set: readonly PermissionKey[], key: PermissionKey): PermissionKey[] =>
  set.filter((k) => k !== key).sort();

// ── The rows ─────────────────────────────────────────────────────────────────

type Actor = 'none' | 'manager' | 'member' | 'viewer' | 'custom';

interface Row {
  accessLevel: ProjectAccessLevel;
  actor: Actor;
  addedToProject: boolean;
  expected: PermissionKey[];
}

const TABLE: Row[] = [
  // ── open — every workspace member holds their role's keys, added or not ──
  { accessLevel: 'open', actor: 'none', addedToProject: false, expected: union(NONE) },
  { accessLevel: 'open', actor: 'none', addedToProject: true, expected: union(NONE) },
  { accessLevel: 'open', actor: 'manager', addedToProject: false, expected: union(MANAGER) },
  { accessLevel: 'open', actor: 'manager', addedToProject: true, expected: union(MANAGER) },
  { accessLevel: 'open', actor: 'member', addedToProject: false, expected: union(MEMBER) },
  { accessLevel: 'open', actor: 'member', addedToProject: true, expected: union(MEMBER) },
  { accessLevel: 'open', actor: 'viewer', addedToProject: false, expected: union(VIEWER) },
  { accessLevel: 'open', actor: 'viewer', addedToProject: true, expected: union(VIEWER) },
  { accessLevel: 'open', actor: 'custom', addedToProject: false, expected: union(CUSTOM) },
  { accessLevel: 'open', actor: 'custom', addedToProject: true, expected: union(CUSTOM) },

  // ── limited — everything but EDIT for someone not added ──
  { accessLevel: 'limited', actor: 'none', addedToProject: false, expected: union(NONE) },
  { accessLevel: 'limited', actor: 'none', addedToProject: true, expected: union(NONE) },
  { accessLevel: 'limited', actor: 'manager', addedToProject: false, expected: union(MANAGER) },
  { accessLevel: 'limited', actor: 'manager', addedToProject: true, expected: union(MANAGER) },
  {
    accessLevel: 'limited',
    actor: 'member',
    addedToProject: false,
    expected: without(MEMBER, 'work_item:edit'),
  },
  { accessLevel: 'limited', actor: 'member', addedToProject: true, expected: union(MEMBER) },
  { accessLevel: 'limited', actor: 'viewer', addedToProject: false, expected: union(VIEWER) },
  { accessLevel: 'limited', actor: 'viewer', addedToProject: true, expected: union(VIEWER) },
  { accessLevel: 'limited', actor: 'custom', addedToProject: false, expected: union(CUSTOM) },
  { accessLevel: 'limited', actor: 'custom', addedToProject: true, expected: union(CUSTOM) },

  // ── private — nothing for someone not added (a Manager excepted) ──
  { accessLevel: 'private', actor: 'none', addedToProject: false, expected: union(NONE) },
  { accessLevel: 'private', actor: 'none', addedToProject: true, expected: union(NONE) },
  { accessLevel: 'private', actor: 'manager', addedToProject: false, expected: union(MANAGER) },
  { accessLevel: 'private', actor: 'manager', addedToProject: true, expected: union(MANAGER) },
  { accessLevel: 'private', actor: 'member', addedToProject: false, expected: union(NONE) },
  { accessLevel: 'private', actor: 'member', addedToProject: true, expected: union(MEMBER) },
  { accessLevel: 'private', actor: 'viewer', addedToProject: false, expected: union(NONE) },
  { accessLevel: 'private', actor: 'viewer', addedToProject: true, expected: union(VIEWER) },
  { accessLevel: 'private', actor: 'custom', addedToProject: false, expected: union(NONE) },
  { accessLevel: 'private', actor: 'custom', addedToProject: true, expected: union(CUSTOM) },

  // ── public — like open for members, plus the public grant for everyone ──
  { accessLevel: 'public', actor: 'none', addedToProject: false, expected: union(PUBLIC) },
  { accessLevel: 'public', actor: 'none', addedToProject: true, expected: union(PUBLIC) },
  {
    accessLevel: 'public',
    actor: 'manager',
    addedToProject: false,
    expected: union(MANAGER, PUBLIC),
  },
  {
    accessLevel: 'public',
    actor: 'manager',
    addedToProject: true,
    expected: union(MANAGER, PUBLIC),
  },
  {
    accessLevel: 'public',
    actor: 'member',
    addedToProject: false,
    expected: union(MEMBER, PUBLIC),
  },
  { accessLevel: 'public', actor: 'member', addedToProject: true, expected: union(MEMBER, PUBLIC) },
  {
    accessLevel: 'public',
    actor: 'viewer',
    addedToProject: false,
    expected: union(VIEWER, PUBLIC),
  },
  { accessLevel: 'public', actor: 'viewer', addedToProject: true, expected: union(VIEWER, PUBLIC) },
  {
    accessLevel: 'public',
    actor: 'custom',
    addedToProject: false,
    expected: union(CUSTOM, PUBLIC),
  },
  { accessLevel: 'public', actor: 'custom', addedToProject: true, expected: union(CUSTOM, PUBLIC) },
];

function inputsFor(
  row: Pick<Row, 'accessLevel' | 'actor' | 'addedToProject'>,
): ProjectAccessInputs {
  const workspaceRole: WorkspaceRole | null =
    row.actor === 'none' ? null : row.actor === 'custom' ? 'member' : row.actor;
  return {
    accessLevel: row.accessLevel,
    workspaceRole,
    addedToProject: row.addedToProject,
    customRolePermissions: row.actor === 'custom' ? [...CUSTOM] : null,
  };
}

/** Each named predicate and the one key it is a membership test for. */
const PREDICATES: [string, (i: ProjectAccessInputs) => boolean, PermissionKey][] = [
  ['canBrowse', canBrowse, 'project:browse'],
  ['canEdit', canEdit, 'work_item:edit'],
  ['canComment', canComment, 'comment:add'],
  ['canModerateComments', canModerateComments, 'comment:moderate'],
  ['canCreateAttachments', canCreateAttachments, 'attachment:create'],
  ['canDeleteAllAttachments', canDeleteAllAttachments, 'attachment:delete_any'],
  ['canManageWatchers', canManageWatchers, 'watcher:manage'],
  ['canManageProject', canManageProject, 'project:administer'],
  ['canSubmitToTriage', canSubmitToTriage, 'public_request:submit'],
  ['canUpvotePublicRequest', canUpvotePublicRequest, 'public_request:upvote'],
  ['canCommentPublicRequest', canCommentPublicRequest, 'public_request:comment'],
];

describe('the literal sets are the built-in roles, transcribed', () => {
  it('Manager, Member and Viewer equal WORKSPACE_ROLE_PERMISSIONS', () => {
    expect(union(MANAGER)).toEqual([...WORKSPACE_ROLE_PERMISSIONS.manager].sort());
    expect(union(MEMBER)).toEqual([...WORKSPACE_ROLE_PERMISSIONS.member].sort());
    expect(union(VIEWER)).toEqual([...WORKSPACE_ROLE_PERMISSIONS.viewer].sort());
  });

  it('the Manager set IS the role-gated catalog, and the public literal the level grant', () => {
    expect(union(MANAGER)).toEqual([...ROLE_GATED_PERMISSIONS].sort());
    expect(union(PUBLIC)).toEqual([...PUBLIC_PROJECT_PERMISSIONS].sort());
  });

  it('every built-in set carries all three view-any keys (DECISION MOTIR-6165 Q2)', () => {
    for (const set of [MANAGER, MEMBER, VIEWER]) {
      for (const key of ['plan:view_any', 'approval:view_any', 'run:view_any'] as const) {
        expect(set).toContain(key);
      }
    }
  });
});

describe('the truth table — 4 levels × 5 actors × added or not', () => {
  it('covers every combination exactly once', () => {
    expect(TABLE).toHaveLength(40);
    const seen = new Set(TABLE.map((r) => `${r.accessLevel}/${r.actor}/${r.addedToProject}`));
    expect(seen.size).toBe(40);
  });

  it.each(TABLE)(
    '$accessLevel · $actor · added=$addedToProject — resolves to exactly its written-out set',
    (row) => {
      const inputs = inputsFor(row);
      expect([...resolvePermissions(inputs)].sort()).toEqual(row.expected);
      // …and every named predicate answers as a membership test of that set.
      for (const [name, predicate, key] of PREDICATES) {
        expect(predicate(inputs), `${name}`).toBe(row.expected.includes(key));
      }
    },
  );
});

describe('the properties the story asserts', () => {
  it('open: a Member not added holds exactly the Member set; a Viewer exactly the Viewer set, no edit', () => {
    expect(
      [
        ...resolvePermissions(
          inputsFor({ accessLevel: 'open', actor: 'member', addedToProject: false }),
        ),
      ].sort(),
    ).toEqual([...WORKSPACE_ROLE_PERMISSIONS.member].sort());
    const viewer = resolvePermissions(
      inputsFor({ accessLevel: 'open', actor: 'viewer', addedToProject: true }),
    );
    expect([...viewer].sort()).toEqual([...WORKSPACE_ROLE_PERMISSIONS.viewer].sort());
    expect(viewer.has('work_item:edit')).toBe(false);
  });

  it('a custom role holds exactly its stored keys — and closing Runs is leaving its key out', () => {
    const held = resolvePermissions(
      inputsFor({ accessLevel: 'open', actor: 'custom', addedToProject: true }),
    );
    expect([...held].sort()).toEqual(union(CUSTOM));
    expect(held.has('run:view_any')).toBe(false);
    expect(held.has('comment:add')).toBe(true);
  });

  it('a Manager holds every role-gated key on every level, added or not', () => {
    for (const accessLevel of ['open', 'limited', 'private', 'public'] as ProjectAccessLevel[]) {
      for (const addedToProject of [false, true]) {
        const held = resolvePermissions(
          inputsFor({ accessLevel, actor: 'manager', addedToProject }),
        );
        for (const key of ROLE_GATED_PERMISSIONS) expect(held.has(key)).toBe(true);
      }
    }
  });

  it('the Manager rail does NOT widen the level-gated public-request grants', () => {
    for (const accessLevel of ['open', 'limited', 'private'] as ProjectAccessLevel[]) {
      const held = resolvePermissions(
        inputsFor({ accessLevel, actor: 'manager', addedToProject: true }),
      );
      expect(held.has('public_request:submit')).toBe(false);
    }
  });

  it('the twelve administrative keys are held by exactly the actors project:administer is', () => {
    const ADMINISTRATIVE_KEYS: readonly PermissionKey[] = [
      'member:manage',
      'project:manage_access',
      'board:configure',
      'workflow:manage',
      'automation:manage',
      'field:manage',
      'component:manage',
      'label:manage',
      'estimation:manage',
      'repository:manage',
      'repository:manage_access',
      'ai:configure',
    ];
    for (const row of TABLE) {
      const inputs = inputsFor(row);
      const administers = hasPermission(inputs, 'project:administer');
      for (const key of ADMINISTRATIVE_KEYS) {
        expect(hasPermission(inputs, key), `${row.accessLevel}/${row.actor} · ${key}`).toBe(
          administers,
        );
      }
    }
  });

  it('an empty custom role grants nothing — it does not fall back to its tier', () => {
    const held = resolvePermissions({
      accessLevel: 'open',
      workspaceRole: 'member',
      addedToProject: true,
      customRolePermissions: [],
    });
    expect(held.size).toBe(0);
  });
});

describe('no project role reaches the calculation', () => {
  it('resolve.ts reads no project membership role and no project custom role', () => {
    const source = readFileSync(join(process.cwd(), 'lib/permissions/resolve.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/projectRole/);
    expect(code).not.toMatch(/ProjectRoleDefinition/);
    expect(code).not.toMatch(/projectMembership/);
    expect(code).not.toMatch(/IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS/);
  });
});
