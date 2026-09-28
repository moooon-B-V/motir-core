import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectAccessMode, WorkspaceRole } from '@/generated/prisma/client';
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
import { canEnter, hasPermission, resolvePermissions } from '@/lib/permissions/resolve';
import {
  PUBLIC_PROJECT_PERMISSIONS,
  ROLE_GATED_PERMISSIONS,
  WORKSPACE_ROLE_PERMISSIONS,
} from '@/lib/permissions/builtinRoles';
import type { PermissionKey } from '@/lib/permissions/catalog';

// THE TRUTH TABLE for the project access policy — REWRITTEN by Story MOTIR-6169 ·
// MOTIR-6543, when access moved onto the project as three MODES and each
// membership gained a SCOPE (`docs/decisions/role-model.md` Q1). Entry is one
// rule (`canEnter`), and an entrant holds exactly their workspace role's set — the
// per-level subtraction MOTIR-6168 left (`limited` losing edit, `private` losing
// everything) retired with the levels. The input space is now:
//
//   3 access modes × { no membership, Manager, a Full Member, a Full Viewer,
//                      a Full custom role, a Limited Member }
//                  × { added to the project, not added }   =   36 rows
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
  // MOTIR-6642 — the Visitor holds the Viewer's view keys.
  'approval:view_any',
  'plan:view_any',
  'project:browse',
  'report:view',
  'public_request:comment',
  'public_request:submit',
  'public_request:upvote',
  'run:view_any',
];

const NONE: readonly PermissionKey[] = [];

const union = (...sets: (readonly PermissionKey[])[]): PermissionKey[] =>
  [...new Set(sets.flat())].sort();

// ── The rows ─────────────────────────────────────────────────────────────────

type Actor = 'none' | 'manager' | 'member' | 'viewer' | 'custom' | 'limitedMember';

interface Row {
  accessMode: ProjectAccessMode;
  actor: Actor;
  addedToProject: boolean;
  expected: PermissionKey[];
}

const TABLE: Row[] = [
  // ── workspace — every Full member enters; a Limited one only if added ──
  { accessMode: 'workspace', actor: 'none', addedToProject: false, expected: union(NONE) },
  { accessMode: 'workspace', actor: 'none', addedToProject: true, expected: union(NONE) },
  { accessMode: 'workspace', actor: 'manager', addedToProject: false, expected: union(MANAGER) },
  { accessMode: 'workspace', actor: 'manager', addedToProject: true, expected: union(MANAGER) },
  { accessMode: 'workspace', actor: 'member', addedToProject: false, expected: union(MEMBER) },
  { accessMode: 'workspace', actor: 'member', addedToProject: true, expected: union(MEMBER) },
  { accessMode: 'workspace', actor: 'viewer', addedToProject: false, expected: union(VIEWER) },
  { accessMode: 'workspace', actor: 'viewer', addedToProject: true, expected: union(VIEWER) },
  { accessMode: 'workspace', actor: 'custom', addedToProject: false, expected: union(CUSTOM) },
  { accessMode: 'workspace', actor: 'custom', addedToProject: true, expected: union(CUSTOM) },
  { accessMode: 'workspace', actor: 'limitedMember', addedToProject: false, expected: union(NONE) },
  {
    accessMode: 'workspace',
    actor: 'limitedMember',
    addedToProject: true,
    expected: union(MEMBER),
  },

  // ── members — only the people added enter (a Manager excepted) ──
  { accessMode: 'members', actor: 'none', addedToProject: false, expected: union(NONE) },
  { accessMode: 'members', actor: 'none', addedToProject: true, expected: union(NONE) },
  { accessMode: 'members', actor: 'manager', addedToProject: false, expected: union(MANAGER) },
  { accessMode: 'members', actor: 'manager', addedToProject: true, expected: union(MANAGER) },
  { accessMode: 'members', actor: 'member', addedToProject: false, expected: union(NONE) },
  { accessMode: 'members', actor: 'member', addedToProject: true, expected: union(MEMBER) },
  { accessMode: 'members', actor: 'viewer', addedToProject: false, expected: union(NONE) },
  { accessMode: 'members', actor: 'viewer', addedToProject: true, expected: union(VIEWER) },
  { accessMode: 'members', actor: 'custom', addedToProject: false, expected: union(NONE) },
  { accessMode: 'members', actor: 'custom', addedToProject: true, expected: union(CUSTOM) },
  { accessMode: 'members', actor: 'limitedMember', addedToProject: false, expected: union(NONE) },
  { accessMode: 'members', actor: 'limitedMember', addedToProject: true, expected: union(MEMBER) },

  // ── public — as workspace, plus the public read set for everyone ──
  { accessMode: 'public', actor: 'none', addedToProject: false, expected: union(PUBLIC) },
  { accessMode: 'public', actor: 'none', addedToProject: true, expected: union(PUBLIC) },
  {
    accessMode: 'public',
    actor: 'manager',
    addedToProject: false,
    expected: union(MANAGER, PUBLIC),
  },
  {
    accessMode: 'public',
    actor: 'manager',
    addedToProject: true,
    expected: union(MANAGER, PUBLIC),
  },
  { accessMode: 'public', actor: 'member', addedToProject: false, expected: union(MEMBER, PUBLIC) },
  { accessMode: 'public', actor: 'member', addedToProject: true, expected: union(MEMBER, PUBLIC) },
  { accessMode: 'public', actor: 'viewer', addedToProject: false, expected: union(VIEWER, PUBLIC) },
  { accessMode: 'public', actor: 'viewer', addedToProject: true, expected: union(VIEWER, PUBLIC) },
  { accessMode: 'public', actor: 'custom', addedToProject: false, expected: union(CUSTOM, PUBLIC) },
  { accessMode: 'public', actor: 'custom', addedToProject: true, expected: union(CUSTOM, PUBLIC) },
  { accessMode: 'public', actor: 'limitedMember', addedToProject: false, expected: union(PUBLIC) },
  {
    accessMode: 'public',
    actor: 'limitedMember',
    addedToProject: true,
    expected: union(MEMBER, PUBLIC),
  },
];

function inputsFor(row: Pick<Row, 'accessMode' | 'actor' | 'addedToProject'>): ProjectAccessInputs {
  const workspaceRole: WorkspaceRole | null =
    row.actor === 'none'
      ? null
      : row.actor === 'custom' || row.actor === 'limitedMember'
        ? 'member'
        : row.actor;
  return {
    accessMode: row.accessMode,
    workspaceRole,
    accessScope: row.actor === 'none' ? null : row.actor === 'limitedMember' ? 'limited' : 'full',
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

describe('the truth table — 3 modes × 6 actors × added or not', () => {
  it('covers every combination exactly once', () => {
    expect(TABLE).toHaveLength(36);
    const seen = new Set(TABLE.map((r) => `${r.accessMode}/${r.actor}/${r.addedToProject}`));
    expect(seen.size).toBe(36);
  });

  it.each(TABLE)(
    '$accessMode · $actor · added=$addedToProject — resolves to exactly its written-out set',
    (row) => {
      const inputs = inputsFor(row);
      expect([...resolvePermissions(inputs)].sort()).toEqual(row.expected);
      // …and every named predicate answers as a membership test of that set.
      for (const [name, predicate, key] of PREDICATES) {
        expect(predicate(inputs), `${name}`).toBe(row.expected.includes(key));
      }
      // …and the actor ENTERS exactly when they hold something beyond the public
      // read set — the listing rule and the resolver agree on every row. The one
      // exception is a VIEWER: since MOTIR-6642 the public set IS the Viewer's
      // plus the request grants, so an entering Viewer holds nothing beyond it in
      // ANY mode, and for them entry is exactly holding anything at all.
      const beyondPublic = row.expected.some((k) => !PUBLIC.includes(k));
      const enteringViewer = row.actor === 'viewer' && row.expected.length > 0;
      expect(canEnter(inputs), 'canEnter').toBe(beyondPublic || enteringViewer);
    },
  );
});

describe('the properties the story asserts', () => {
  it('an entrant holds exactly WORKSPACE_ROLE_PERMISSIONS[role] in every mode (plus the public set on public)', () => {
    for (const accessMode of ['workspace', 'members', 'public'] as ProjectAccessMode[]) {
      for (const actor of ['manager', 'member', 'viewer'] as const) {
        const held = [
          ...resolvePermissions(inputsFor({ accessMode, actor, addedToProject: true })),
        ];
        const role = [...WORKSPACE_ROLE_PERMISSIONS[actor]];
        expect(held.sort(), `${accessMode}/${actor}`).toEqual(
          accessMode === 'public' ? union(role, PUBLIC) : union(role),
        );
      }
    }
  });

  it('workspace: a Full Member not added holds exactly the Member set; a Viewer exactly the Viewer set, no edit', () => {
    expect(
      [
        ...resolvePermissions(
          inputsFor({ accessMode: 'workspace', actor: 'member', addedToProject: false }),
        ),
      ].sort(),
    ).toEqual([...WORKSPACE_ROLE_PERMISSIONS.member].sort());
    const viewer = resolvePermissions(
      inputsFor({ accessMode: 'workspace', actor: 'viewer', addedToProject: true }),
    );
    expect([...viewer].sort()).toEqual([...WORKSPACE_ROLE_PERMISSIONS.viewer].sort());
    expect(viewer.has('work_item:edit')).toBe(false);
  });

  it('a custom role holds exactly its stored keys — and closing Runs is leaving its key out', () => {
    const held = resolvePermissions(
      inputsFor({ accessMode: 'workspace', actor: 'custom', addedToProject: true }),
    );
    expect([...held].sort()).toEqual(union(CUSTOM));
    expect(held.has('run:view_any')).toBe(false);
    expect(held.has('comment:add')).toBe(true);
  });

  it('a Manager holds every role-gated key in every mode, added or not', () => {
    for (const accessMode of ['workspace', 'members', 'public'] as ProjectAccessMode[]) {
      for (const addedToProject of [false, true]) {
        const held = resolvePermissions(
          inputsFor({ accessMode, actor: 'manager', addedToProject }),
        );
        for (const key of ROLE_GATED_PERMISSIONS) expect(held.has(key)).toBe(true);
      }
    }
  });

  it('the Manager rail does NOT widen the mode-gated public-request grants', () => {
    for (const accessMode of ['workspace', 'members'] as ProjectAccessMode[]) {
      const held = resolvePermissions(
        inputsFor({ accessMode, actor: 'manager', addedToProject: true }),
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
        expect(hasPermission(inputs, key), `${row.accessMode}/${row.actor} · ${key}`).toBe(
          administers,
        );
      }
    }
  });

  it('an empty custom role grants nothing — it does not fall back to its tier', () => {
    const held = resolvePermissions({
      accessMode: 'workspace',
      workspaceRole: 'member',
      accessScope: 'full',
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
