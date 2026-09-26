import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectAccessLevel } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workspaceRoleDefinitionService } from '@/lib/services/workspaceRoleDefinitionService';
import { NotAMemberError } from '@/lib/workspaces/errors';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import {
  ENFORCED_PERMISSIONS,
  PERMISSIONS,
  isEnforced,
  type PermissionKey,
} from '@/lib/permissions/catalog';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { CUSTOM_WORKSPACE_ROLE_TIER } from '@/lib/workspaces/roles';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { grantablePermissionKeys } from '@/lib/permissions/grantable';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `projectAccessService.getPermissions` / `getRoleCatalog` (Story MOTIR-2255 ·
// Subtask MOTIR-2262) against REAL Postgres — real membership rows, resolved
// through the real service, never a mocked `resolveInputs`.
//
// ⚠️ ROLES ARE THE WORKSPACE'S since Story MOTIR-6168 · MOTIR-6459. The scenario
// below still writes a legacy PROJECT role on three actors, and that is on
// purpose: the `admin` actor is a workspace Member holding a project `admin` row,
// and the table proves it grants nothing — they resolve as the Member they are. The pure resolution already has an exhaustive truth table
// (`accessParity.test.ts`); what this file proves is the OTHER half — that the
// three facts the service reads out of the database are the three facts the
// policy expects, and that the DTO boundary is deterministic.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

interface Scenario {
  workspaceId: string;
  projectId: string;
  ctxs: Record<
    'owner' | 'wsAdmin' | 'plainMember' | 'viewer' | 'member' | 'admin',
    WorkspaceContext
  >;
}

/**
 * A workspace + project at `level`, with one real actor per role. Mirrors the
 * ordering `tests/project-access-service.test.ts` established: the access level
 * is set FIRST (going `private` auto-seeds the then-current workspace members as
 * project members — at that point only the owner exists), everyone else after.
 */
async function buildScenario(level: ProjectAccessLevel, slug: string): Promise<Scenario> {
  const owner = await usersService.createUser({
    email: `owner-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);

  if (level === 'public') {
    // `public` is not settable through the service setter yet (6.12.8), so seed
    // it at the data layer exactly as the sibling suite does.
    await adminDb.project.update({ where: { id: project.id }, data: { accessLevel: 'public' } });
  } else {
    await projectMembersService.setAccessLevel({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level,
    });
  }

  const wsAdmin = await usersService.createUser({
    email: `wsadmin-${slug}@ex.com`,
    password: PASSWORD,
    name: 'WsAdmin',
  });
  await workspacesService.addMember({
    userId: wsAdmin.id,
    workspaceId: workspace.id,
    role: 'admin',
  });

  const plainMember = await usersService.createUser({
    email: `plain-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Plain',
  });
  await workspacesService.addMember({ userId: plainMember.id, workspaceId: workspace.id });

  // The Viewer actor is a workspace VIEWER; the other two are workspace Members
  // whose project role is legacy data the resolver no longer reads.
  async function projectActor(role: 'viewer' | 'member' | 'admin') {
    const u = await usersService.createUser({
      email: `${role}-${slug}@ex.com`,
      password: PASSWORD,
      name: role,
    });
    await workspacesService.addMember({
      userId: u.id,
      workspaceId: workspace.id,
      ...(role === 'viewer' ? { role: 'viewer' as const } : {}),
    });
    // The LEGACY project row, written raw — the project role nothing reads now.
    await adminDb.projectMembership.create({
      data: { userId: u.id, projectId: project.id, workspaceId: workspace.id, role },
    });
    return u;
  }
  const viewer = await projectActor('viewer');
  const member = await projectActor('member');
  const admin = await projectActor('admin');

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    ctxs: {
      owner: ownerCtx,
      wsAdmin: ctxFor(wsAdmin.id, workspace.id),
      plainMember: ctxFor(plainMember.id, workspace.id),
      viewer: ctxFor(viewer.id, workspace.id),
      member: ctxFor(member.id, workspace.id),
      admin: ctxFor(admin.id, workspace.id),
    },
  };
}

/**
 * The six MOTIR-2291 keys a project MEMBER holds — `docs/decisions/member-facing-permissions.md`
 * §1. Written out rather than derived from `BUILTIN_ROLE_PERMISSIONS.member`, for
 * the same reason the sets below are: deriving the expectation from the constant
 * under test proves only that the constant equals itself.
 *
 * ⚠️ `import:run` and `work_item:delete` are DELIBERATELY absent — both mirrors
 * put a bulk import and a delete cascade at admin, so a project member loses
 * them when their wiring cards land. `work_item:archive` (MOTIR-3629) is NOT the
 * same answer re-litigated: it is the OTHER operation `work_item:delete` was
 * carrying — reversible, one row — and a member holds it. The rows below list it
 * beside this helper rather than in it, since it belongs to neither MOTIR-2291's
 * six nor this helper's argument.
 */
function MEMBER_FACING_AT_MEMBER(): PermissionKey[] {
  return [
    'sprint:manage',
    'report:view',
    'saved_filter:manage',
    'work_item:triage',
    'ai:plan',
    'ai:view_plan',
  ];
}

/** The Member set, written out (the old project `member` set, carried over). */
function MEMBER_SET(): PermissionKey[] {
  return [
    'project:browse',
    'work_item:edit',
    'comment:add',
    'attachment:create',
    ...MEMBER_FACING_AT_MEMBER(),
    // MOTIR-3188 — the DECIDE half, split out of `ai:view_plan`.
    'ai:decide_plan',
    // MOTIR-3629 — the REVERSIBLE removal, split out of `work_item:delete`.
    'work_item:archive',
    // MOTIR-6328 — the three rooms' view-any keys.
    ...ROOM_VIEW_KEYS(),
  ];
}

/** The Viewer set, written out. */
function VIEWER_SET(): PermissionKey[] {
  return ['project:browse', 'report:view', ...ROOM_VIEW_KEYS()];
}

/**
 * The permissions each actor holds, per access level — read off real DB rows.
 *
 * Since MOTIR-6459 the key is the WORKSPACE role, and the project records only
 * whether the actor was ADDED: `plainMember` is a workspace Member never added;
 * `viewer` a workspace Viewer who was; `member` and `admin` workspace Members who
 * were (the `admin` actor's project admin row grants nothing).
 */
const EXPECTED: Record<ProjectAccessLevel, Record<keyof Scenario['ctxs'], PermissionKey[]>> = {
  open: {
    owner: [...ROLE_GATED_PERMISSIONS],
    wsAdmin: [...ROLE_GATED_PERMISSIONS],
    // A Member not added holds their role's normal keys — the one widening the
    // model decides (it used to be the implicit workspace-member set).
    plainMember: MEMBER_SET(),
    viewer: VIEWER_SET(),
    member: MEMBER_SET(),
    admin: MEMBER_SET(),
  },
  limited: {
    owner: [...ROLE_GATED_PERMISSIONS],
    wsAdmin: [...ROLE_GATED_PERMISSIONS],
    // Not added: everything but EDIT.
    plainMember: MEMBER_SET().filter((k) => k !== 'work_item:edit'),
    viewer: VIEWER_SET(),
    member: MEMBER_SET(),
    admin: MEMBER_SET(),
  },
  private: {
    owner: [...ROLE_GATED_PERMISSIONS],
    wsAdmin: [...ROLE_GATED_PERMISSIONS],
    // Invisible to anyone not added — including for `report:view`.
    plainMember: [],
    viewer: VIEWER_SET(),
    member: MEMBER_SET(),
    admin: MEMBER_SET(),
  },
  public: {
    owner: [...ROLE_GATED_PERMISSIONS, ...PUBLIC_KEYS()],
    wsAdmin: [...ROLE_GATED_PERMISSIONS, ...PUBLIC_KEYS()],
    plainMember: [...MEMBER_SET(), ...PUBLIC_KEYS()],
    viewer: [...VIEWER_SET(), ...PUBLIC_KEYS()],
    member: [...MEMBER_SET(), ...PUBLIC_KEYS()],
    admin: [...MEMBER_SET(), ...PUBLIC_KEYS()],
  },
};

/**
 * MOTIR-6328 (Story MOTIR-6179, `member-facing-permissions.md` AMENDMENT 1) —
 * the three rooms' view-any keys every built-in role that browses holds, and the
 * two of them the implicit workspace-member grant and the `public` level add.
 * Written out for the same reason as {@link MEMBER_FACING_AT_MEMBER}.
 */
function ROOM_VIEW_KEYS(): PermissionKey[] {
  return ['approval:view_any', 'plan:view_any', 'run:view_any'];
}
function PLAN_RUN_VIEW_KEYS(): PermissionKey[] {
  return ['plan:view_any', 'run:view_any'];
}

/** The role screens draw ENFORCED keys only; a `planned` one is held but not drawn. */
function drawn(keys: PermissionKey[]): PermissionKey[] {
  return keys.filter((key) => isEnforced(key));
}

function PUBLIC_KEYS(): PermissionKey[] {
  return ['public_request:submit', 'public_request:upvote', 'public_request:comment'];
}

describe.each(['open', 'limited', 'private', 'public'] as const)(
  'getPermissions on a %s project — real ProjectMembership rows',
  (level) => {
    it('resolves each role to the permissions the shipped policy grants it', async () => {
      const scenario = await buildScenario(level, `gp-${level}`);
      for (const [role, ctx] of Object.entries(scenario.ctxs) as [
        keyof Scenario['ctxs'],
        WorkspaceContext,
      ][]) {
        const held = await projectAccessService.getPermissions(scenario.projectId, ctx);
        expect([...held].sort(), `${role} on a ${level} project`).toEqual(
          [...EXPECTED[level][role]].sort(),
        );
      }
    });
  },
);

describe('the rails, resolved through the database', () => {
  it('a workspace owner holds the whole role-gated catalog', async () => {
    const s = await buildScenario('private', 'rail-owner');
    const held = await projectAccessService.getPermissions(s.projectId, s.ctxs.owner);
    for (const key of ROLE_GATED_PERMISSIONS) {
      expect(held.has(key), `owner lacks ${key}`).toBe(true);
    }
  });

  // MOTIR-5305 — `approval:view_any`, the Approvals room's full view. Asserted
  // through the SERVICE rather than by reading the constant, because what the room
  // will consult is `getPermissions`, and the rail is the part a constant cannot show.
  // MOTIR-6328 (DECISION MOTIR-6165 Q2) widened it to `member` and `viewer`.
  it('`approval:view_any` resolves for the rail, the built-in admin, member and viewer', async () => {
    const s = await buildScenario('private', 'view-any');
    const holds = async (who: keyof Scenario['ctxs']) =>
      (await projectAccessService.getPermissions(s.projectId, s.ctxs[who])).has(
        'approval:view_any',
      );
    expect(await holds('owner'), 'workspace owner, through the always-pass rail').toBe(true);
    expect(await holds('wsAdmin'), 'workspace admin, through the always-pass rail').toBe(true);
    expect(await holds('admin'), 'a Member with a legacy project admin row').toBe(true);
    expect(await holds('member'), 'every built-in role that browses holds it').toBe(true);
    expect(await holds('viewer'), 'every built-in role that browses holds it').toBe(true);
  });

  it('`approval:view_any` is OFFERED once enforced — on the role screens, and grantable to a custom role (MOTIR-5301)', async () => {
    const s = await buildScenario('open', 'view-any-offered');
    expect(ENFORCED_PERMISSIONS).toContain('approval:view_any');
    const { catalog } = await workspaceRoleDefinitionService.getRolesPageCatalog(
      s.workspaceId,
      s.ctxs.owner,
    );
    const rows = catalog.domains.flatMap((d) => d.permissions.map((p) => p.key));
    expect(rows).toContain('approval:view_any');
    expect(catalog.roles.find((r) => r.key === 'manager')?.permissions).toContain(
      'approval:view_any',
    );
    expect(catalog.roles.find((r) => r.key === 'member')?.permissions).toContain(
      'approval:view_any',
    );
    expect(grantablePermissionKeys().has('approval:view_any')).toBe(true);
  });

  it('an actor with no workspace membership holds nothing on a non-public project', async () => {
    const s = await buildScenario('open', 'rail-null');
    const outsider = await usersService.createUser({
      email: 'outsider-rail@ex.com',
      password: PASSWORD,
      name: 'Outsider',
    });
    // Same workspace id in the context, but NO membership row backing it.
    const held = await projectAccessService.getPermissions(
      s.projectId,
      ctxFor(outsider.id, s.workspaceId),
    );
    expect([...held]).toEqual([]);
  });
});

describe('the cross-workspace posture is preserved — 404, never 403', () => {
  it('getPermissions throws ProjectNotFoundError for a project in another workspace', async () => {
    const mine = await buildScenario('open', 'leak-mine');
    const theirs = await buildScenario('open', 'leak-theirs');
    await expect(
      projectAccessService.getPermissions(theirs.projectId, mine.ctxs.owner),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('the Roles catalog of a workspace the reader is not in is not-found', async () => {
    const mine = await buildScenario('open', 'leak2-mine');
    const theirs = await buildScenario('open', 'leak2-theirs');
    await expect(
      workspaceRoleDefinitionService.getRolesPageCatalog(theirs.workspaceId, mine.ctxs.owner),
    ).rejects.toBeInstanceOf(NotAMemberError);
  });

  it('getPermissions throws ProjectNotFoundError for an id that never existed', async () => {
    const s = await buildScenario('open', 'leak3');
    await expect(
      projectAccessService.getPermissions('does-not-exist', s.ctxs.owner),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('the DTO boundary is serialisable and deterministic', () => {
  it('getPermissionsDTO returns a JSON-serialisable, catalog-ordered array', async () => {
    const s = await buildScenario('open', 'dto-actor');
    const dto = await projectAccessService.getPermissionsDTO(s.projectId, s.ctxs.member);
    expect(dto.projectId).toBe(s.projectId);
    expect(Array.isArray(dto.permissions)).toBe(true);
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
    // Catalog order, not insertion order — the array is a subsequence of PERMISSIONS.
    const positions = dto.permissions.map((k) => PERMISSIONS.indexOf(k));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('the workspace Roles catalog returns the three built-in roles, each with its set in catalog order', async () => {
    const s = await buildScenario('open', 'dto-catalog');
    const { catalog } = await workspaceRoleDefinitionService.getRolesPageCatalog(
      s.workspaceId,
      s.ctxs.member,
    );

    expect(catalog.roles.map((r) => r.key)).toEqual(['manager', 'member', 'viewer']);
    for (const role of catalog.roles) {
      expect(role.builtIn, `${role.key} must be marked built-in`).toBe(true);
      expect(role.labelKey).toBe(`settings.roles.${role.key}.name`);
      const positions = role.permissions.map((k) => PERMISSIONS.indexOf(k));
      expect(positions, `${role.key} permissions out of catalog order`).toEqual(
        [...positions].sort((a, b) => a - b),
      );
    }

    // The sets the grid will render, spelled out so a silent widening fails here.
    // MOTIR-2349 widened two of them ON PURPOSE — a viewer gains `report:view`,
    // a member gains six — and MOTIR-3188 widened `member` by one more, also on
    // purpose: `ai:decide_plan`, split out of `ai:view_plan`, lands exactly where
    // the key it was cut from already sat. MOTIR-3629 widens `member` once more,
    // and this one does NOT land where its parent sat: `work_item:archive` was
    // cut from `work_item:delete`, which `member` does not hold, so this is the
    // one addition here that changes what a member can DO. It is argued in
    // `docs/decisions/token-permissions.md` §10 — a member could already edit
    // every field and could not hide a row, which is a stronger restriction than
    // "may not destroy a subtree" and one nobody chose. Those are the only
    // additions this assertion admits.
    //
    // ⚠️ MOTIR-4793 once added `work_item:merge_pull_request` here, and MOTIR-5616
    // RETIRED it (Bug MOTIR-5603): a card holds ONE approve-to-merge gate whose floor
    // is `work_item:edit`, which every holder of the retired key already had. Its
    // absence below is therefore the assertion that no built-in role grants a key
    // nothing enforces.
    // MOTIR-6328 adds the three rooms' view-any keys to both (AMENDMENT 1), each
    // drawn once its read enforces it.
    expect([...(catalog.roles.find((r) => r.key === 'viewer')?.permissions ?? [])].sort()).toEqual(
      drawn(['project:browse', 'report:view', ...ROOM_VIEW_KEYS()]).sort(),
    );
    expect([...(catalog.roles.find((r) => r.key === 'member')?.permissions ?? [])].sort()).toEqual(
      [
        'project:browse',
        'work_item:edit',
        'work_item:archive',
        'comment:add',
        'attachment:create',
        ...MEMBER_FACING_AT_MEMBER(),
        'ai:decide_plan',
        ...drawn(ROOM_VIEW_KEYS()),
      ].sort(),
    );
    // Compare as a SET: the DTO emits catalog order, which MOTIR-2277 changed
    // when it grouped the keys by domain. The membership is the contract, not
    // the ordering of the source constant.
    // …minus any role-gated key still `planned` (MOTIR-5305's `approval:view_any`),
    // which the admin set HOLDS and no role screen may draw.
    expect([...(catalog.roles.find((r) => r.key === 'manager')?.permissions ?? [])].sort()).toEqual(
      ROLE_GATED_PERMISSIONS.filter((key) => isEnforced(key)).sort(),
    );

    // No role holds a level-gated public-request grant — a role cannot give one.
    for (const role of catalog.roles) {
      for (const key of role.permissions) {
        expect(key.startsWith('public_request:'), `${role.key} holds ${key}`).toBe(false);
      }
    }
  });

  it('groups every ROLE-GATED permission under a labelled, non-empty domain', async () => {
    const s = await buildScenario('open', 'dto-domains');
    const { catalog } = await workspaceRoleDefinitionService.getRolesPageCatalog(
      s.workspaceId,
      s.ctxs.member,
    );
    const flattened = catalog.domains.flatMap((d) => d.permissions.map((p) => p.key));
    // ⚠️ NARROWED BY MOTIR-2439, and the narrowing is the point. This used to
    // assert the WHOLE catalog, on the reasoning that the settings page must show
    // the whole model rather than a quarter of it. That reasoning stands and is
    // unchanged — what changed is which set "the whole model" means for a screen
    // about ROLES. The three level-gated `public_request:*` keys are decided by
    // the project's ACCESS LEVEL for every actor including an anonymous one, so no
    // role can hold or withhold one; drawn as role rows they are a permanent dash
    // against every role, which reads as "nobody has this" rather than "roles do
    // not govern this". They are not hidden — they get their own card.
    // The screens draw the role-gated keys a gate CONSULTS: a `planned` key may be
    // role-holdable already (MOTIR-5305) and still never renders as a switch.
    const offered = ROLE_GATED_PERMISSIONS.filter((key) => isEnforced(key));
    expect([...flattened].sort()).toEqual([...offered].sort());
    expect(ENFORCED_PERMISSIONS.filter((k) => !flattened.includes(k)).sort()).toEqual(
      PERMISSIONS.filter((k) => k.startsWith('public_request:')).sort(),
    );
    // Every row the screens draw is live.
    expect(flattened.filter((k) => !ENFORCED_PERMISSIONS.includes(k))).toEqual([]);
    for (const domain of catalog.domains) {
      expect(domain.permissions.length, `${domain.domain} is empty`).toBeGreaterThan(0);
      expect(domain.labelKey).toBe(`permissions.domain.${domain.domain}`);
    }
    // The `M` in the list row's `N of M`, carried on the DTO so no client
    // re-derives it by importing the catalog.
    expect(catalog.roleGatedPermissionCount).toBe(offered.length);
    expect(catalog.roleGatedPermissionCount).toBe(flattened.length);
    // …and the keys the role rows leave out come back on their own card, so the
    // two together are the whole catalog and nothing falls off the page.
    const levelGated = catalog.levelGatedDomains.flatMap((d) => d.permissions.map((p) => p.key));
    expect([...flattened, ...levelGated].sort()).toEqual([...ENFORCED_PERMISSIONS].sort());
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });
});

// The per-role headcount the list row draws (Subtask MOTIR-2439) — read back
// through the service against the memberships `buildScenario` actually seeds, so
// the numbers are checked against real rows rather than against the mapper.
// `getRoleCatalog`'s per-role headcount retired with the project roles (Story
// MOTIR-6168 · MOTIR-6464) — a project membership holds no role; the catalog
// counts nobody (asserted below) and the workspace Roles page counts holders.
describe('a membership on a WORKSPACE custom role, resolved through the database (MOTIR-6459)', () => {
  /**
   * Put `userId` on a brand-new WORKSPACE custom role, writing BOTH columns
   * through `setWorkspaceRole` — the only sanctioned writer, which holds
   * `workspace_role = CUSTOM_WORKSPACE_ROLE_TIER`. Returns the role's id.
   * (Through the admin client: the workspace role service is MOTIR-6460's.)
   */
  async function putOnCustomRole(args: {
    workspaceId: string;
    userId: string;
    name: string;
    permissions: string[];
    workspaceRole?: 'manager' | 'member';
  }): Promise<string> {
    const definition = await adminDb.workspaceRoleDefinition.create({
      data: { workspaceId: args.workspaceId, name: args.name, permissions: args.permissions },
    });
    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        args.userId,
        args.workspaceId,
        {
          workspaceRole: args.workspaceRole ?? CUSTOM_WORKSPACE_ROLE_TIER,
          roleDefinitionId: definition.id,
        },
        tx,
      ),
    );
    return definition.id;
  }

  it('resolves the ROLE`s set, not the built-in the membership used to name', async () => {
    const s = await buildScenario('open', 'custom-basic');
    // The `member` actor moves onto a Contractor role: viewer-based, plus
    // comments and attachments — the epic's own motivating gap.
    await putOnCustomRole({
      workspaceId: s.workspaceId,
      userId: s.ctxs.member.userId,
      name: 'Contractor',
      permissions: ['project:browse', 'comment:add', 'attachment:create'],
    });

    const held = await projectAccessService.getPermissions(s.projectId, s.ctxs.member);
    expect([...held].sort()).toEqual(['attachment:create', 'comment:add', 'project:browse'].sort());
    // Specifically NOT what `member` holds — the whole point.
    expect(held.has('work_item:edit')).toBe(false);
    expect(held.has('sprint:manage')).toBe(false);

    // And the sibling on a built-in is untouched by any of it.
    const untouched = await projectAccessService.getPermissions(s.projectId, s.ctxs.viewer);
    expect(untouched.has('comment:add')).toBe(false);
  });

  it('the Manager RAIL wins over a custom role a Manager row happens to point at', async () => {
    const s = await buildScenario('private', 'custom-rail');
    // A Manager is never ON a custom role, but a row carrying both is the shape
    // a bad write would leave — and the rail must still win, so no role
    // somebody authored can lock a Manager out.
    await putOnCustomRole({
      workspaceId: s.workspaceId,
      userId: s.ctxs.owner.userId,
      name: 'Nearly nothing',
      permissions: [], // grants absolutely nothing
      workspaceRole: 'manager',
    });
    const held = await projectAccessService.getPermissions(s.projectId, s.ctxs.owner);
    for (const key of ROLE_GATED_PERMISSIONS) {
      expect(held.has(key), `owner lacks ${key}`).toBe(true);
    }
  });

  // ⚠️ FOUR ROUNDS, each seeding a scenario and ending in `truncateAuthTables()`
  // — a per-round database reset, which is lock-wait bound rather than CPU bound
  // and so degrades non-linearly under shard contention. That is the shape that
  // timed out twice on `Vitest (7/12)` in `planningTargetLockGate.test.ts`
  // (MOTIR-3736, MOTIR-4089), and this was the only other instance of it in the
  // tree. Measured at 691 ms locally; 60 s is ~87x that, so reaching it means a
  // hang rather than a busy runner. `tests/timeout-budget-lane.test.ts` is what
  // found this test and what keeps the third one from being written.
  it(
    'the access LEVEL subtracts NOTHING — a custom role grants exactly what it lists',
    { timeout: 60_000 },
    async () => {
      // The actor was ADDED to the project, and the level reads only that — so a
      // custom role grants exactly what it lists on every level (MOTIR-6459; the
      // `based_on` decision of 2026-08-09 carried to the workspace).
      const permissions = ['project:browse', 'work_item:edit', 'comment:add', 'attachment:create'];
      for (const level of ['open', 'limited', 'private', 'public'] as const) {
        const s = await buildScenario(level, `custom-level-${level}`);
        await putOnCustomRole({
          workspaceId: s.workspaceId,
          userId: s.ctxs.viewer.userId,
          name: 'Contractor',
          permissions,
        });
        const held = await projectAccessService.getPermissions(s.projectId, s.ctxs.viewer);
        for (const key of permissions) {
          expect(held.has(key as PermissionKey), `${level} · ${key}`).toBe(true);
        }
        // …and it gains nothing either: the set is the whole answer.
        expect([...held].sort()).toEqual(
          level === 'public'
            ? [...permissions, ...PLAN_RUN_VIEW_KEYS(), ...PUBLIC_KEYS()].sort()
            : [...permissions].sort(),
        );
        await truncateAuthTables();
      }
    },
  );

  it('a BUILT-IN role is still narrowed by the level — the change is custom-only', async () => {
    // The other half, and the one that proves nothing leaked: an ordinary
    // `viewer` on a `limited` project still cannot edit.
    const s = await buildScenario('limited', 'builtin-still-narrowed');
    const held = await projectAccessService.getPermissions(s.projectId, s.ctxs.plainMember);
    expect(held.has('project:browse')).toBe(true);
    expect(held.has('work_item:edit')).toBe(false);
  });

  it('a stored key that is no longer in the catalog is ignored, not granted', async () => {
    const s = await buildScenario('open', 'custom-stale');
    await putOnCustomRole({
      workspaceId: s.workspaceId,
      userId: s.ctxs.member.userId,
      name: 'Stale',
      // `repository:connect` is the real shape: MOTIR-2294 retired it. A row
      // authored before that is exactly this.
      permissions: ['project:browse', 'repository:connect', 'not:a:permission'],
    });
    const held = await projectAccessService.getPermissions(s.projectId, s.ctxs.member);
    expect([...held]).toEqual(['project:browse']);
  });

  it('the role definition is INVISIBLE under a foreign workspace GUC — the actor resolves as if it did not exist', async () => {
    const s = await buildScenario('open', 'custom-rls');
    const other = await buildScenario('open', 'custom-rls-other');
    const roleId = await putOnCustomRole({
      workspaceId: s.workspaceId,
      userId: s.ctxs.member.userId,
      name: 'Contractor',
      permissions: ['project:browse', 'comment:add'],
    });

    // Under the OTHER workspace's GUC, dropped to the non-bypass app role, the
    // role row is hidden — so there is no way to read its set across the tenant
    // boundary.
    const leaked = await adminDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${other.workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.workspaceRoleDefinition.findMany({ where: { id: roleId } });
    });
    expect(leaked).toEqual([]);

    // Under its OWN workspace's GUC it is right there — so the emptiness above
    // is the policy biting, not a missing row.
    const visible = await adminDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${s.workspaceId}, true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.workspaceRoleDefinition.findMany({ where: { id: roleId } });
    });
    expect(visible.map((r) => r.id)).toEqual([roleId]);
  });

  it('resolveInputs reads the membership AND its role in ONE round trip, inside the caller`s tx', async () => {
    const s = await buildScenario('open', 'custom-onetrip');
    await putOnCustomRole({
      workspaceId: s.workspaceId,
      userId: s.ctxs.member.userId,
      name: 'Contractor',
      permissions: ['project:browse', 'comment:add'],
    });

    // Count the SELECTs the gate issues, with and without a custom role in
    // play. Reading the role definition must cost ZERO extra queries — it rides
    // the membership read's `include` — so the two counts are equal, and both
    // run entirely inside the caller's transaction (no second connection).
    async function countSelectsFor(ctx: WorkspaceContext): Promise<number> {
      let selects = 0;
      const client = adminDb.$extends({
        query: {
          async $allOperations({ args, query, operation }) {
            if (operation.startsWith('find') || operation === 'count') selects += 1;
            return query(args);
          },
        },
      });
      await (client as unknown as typeof db).$transaction(async (tx) => {
        await projectAccessService.assertPermission(s.projectId, ctx, 'project:browse', tx);
      });
      return selects;
    }

    const withCustom = await countSelectsFor(s.ctxs.member);
    const withBuiltIn = await countSelectsFor(s.ctxs.viewer);
    expect(withCustom).toBe(withBuiltIn);
    // And it really is the three facts, not a fourth read bolted on.
    expect(withCustom).toBe(3);
  });

  it('moving a membership BACK to a built-in restores that built-in`s set', async () => {
    const s = await buildScenario('open', 'custom-back');
    await putOnCustomRole({
      workspaceId: s.workspaceId,
      userId: s.ctxs.member.userId,
      name: 'Contractor',
      permissions: ['project:browse'],
    });
    expect([...(await projectAccessService.getPermissions(s.projectId, s.ctxs.member))]).toEqual([
      'project:browse',
    ]);

    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        s.ctxs.member.userId,
        s.workspaceId,
        { workspaceRole: 'member', roleDefinitionId: null },
        tx,
      ),
    );
    const restored = await projectAccessService.getPermissions(s.projectId, s.ctxs.member);
    expect(restored.has('work_item:edit')).toBe(true);
    expect(restored.has('comment:add')).toBe(true);
  });
});

describe('the workspace role decides every project at once (MOTIR-6459)', () => {
  it("changing one person's workspace_role member → viewer changes their keys in TWO projects, with no per-project write", async () => {
    const s = await buildScenario('open', 'two-projects');
    const second = await projectsService.createProject({
      workspaceId: s.workspaceId,
      actorUserId: s.ctxs.owner.userId,
      name: 'Second project',
    });
    const who = s.ctxs.plainMember;
    for (const projectId of [s.projectId, second.id]) {
      expect(
        (await projectAccessService.getPermissions(projectId, who)).has('work_item:edit'),
      ).toBe(true);
    }
    const projectRowsBefore = await adminDb.projectMembership.count({
      where: { userId: who.userId },
    });

    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        who.userId,
        s.workspaceId,
        { workspaceRole: 'viewer', roleDefinitionId: null },
        tx,
      ),
    );

    for (const projectId of [s.projectId, second.id]) {
      const held = await projectAccessService.getPermissions(projectId, who);
      expect([...held].sort()).toEqual(VIEWER_SET().sort());
    }
    // Nothing per project was written to get there.
    expect(await adminDb.projectMembership.count({ where: { userId: who.userId } })).toBe(
      projectRowsBefore,
    );
  });

  it('a NULL workspace_role resolves by the legacy mapping — the deploy-window fallback', async () => {
    const s = await buildScenario('open', 'null-fallback');
    // The row the still-serving OLD build writes during a deploy: the legacy
    // column only, workspace_role NULL. (The service writes both since MOTIR-6462,
    // so the fixture clears the new column to recreate that row.)
    await adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId: s.ctxs.wsAdmin.userId, workspaceId: s.workspaceId } },
      data: { workspaceRole: null },
    });
    const row = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: s.ctxs.wsAdmin.userId, workspaceId: s.workspaceId } },
    });
    expect([row.role, row.workspaceRole]).toEqual(['admin', null]);
    const held = await projectAccessService.getPermissions(s.projectId, s.ctxs.wsAdmin);
    expect([...held].sort()).toEqual([...ROLE_GATED_PERMISSIONS].sort());
  });

  it('the org Owner with NO workspace membership still passes every role-gated key in a private project (MOTIR-6308)', async () => {
    const s = await buildScenario('private', 'owner-reach');
    const org = await adminDb.workspace.findUniqueOrThrow({ where: { id: s.workspaceId } });
    const orgOwner = await usersService.createUser({
      email: 'org-owner-reach@ex.com',
      password: PASSWORD,
      name: 'Org Owner',
    });
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: org.organizationId, role: 'owner' },
      data: { role: 'admin' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: org.organizationId, userId: orgOwner.id, role: 'owner' },
    });
    const ctx = ctxFor(orgOwner.id, s.workspaceId);
    for (const key of ROLE_GATED_PERMISSIONS) {
      await expect(
        projectAccessService.assertPermission(s.projectId, ctx, key),
        `org Owner refused ${key}`,
      ).resolves.toBeUndefined();
    }
  });
});

// The project's OWN role catalog retired with the project roles (Story
// MOTIR-6168 · MOTIR-6464 / MOTIR-6466). Custom roles are the WORKSPACE's, and
// its catalog — built-ins then custom roles by name, holder counts, the gate
// before the read — is `tests/workspaces/workspaceRoleRoutes.test.ts` and
// `tests/workspaces/rolesPageCatalog.test.ts`.

describe('getPermissions agrees with the capability method it generalises', () => {
  it('matches getSettingsCapabilities for every role on a limited project', async () => {
    const s = await buildScenario('limited', 'agree');
    for (const [role, ctx] of Object.entries(s.ctxs) as [
      keyof Scenario['ctxs'],
      WorkspaceContext,
    ][]) {
      const held = await projectAccessService.getPermissions(s.projectId, ctx);
      const caps = await projectAccessService.getSettingsCapabilities(s.projectId, ctx);
      expect(held.has('project:browse'), `${role} browse`).toBe(caps.canBrowse);
      expect(held.has('work_item:edit'), `${role} edit`).toBe(caps.canEdit);
      expect(held.has('project:administer'), `${role} manage`).toBe(caps.canManage);
    }
  });
});
