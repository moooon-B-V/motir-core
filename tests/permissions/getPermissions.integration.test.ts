import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectAccessLevel } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { ENFORCED_PERMISSIONS, PERMISSIONS, type PermissionKey } from '@/lib/permissions/catalog';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// `projectAccessService.getPermissions` / `getRoleCatalog` (Story MOTIR-2255 ·
// Subtask MOTIR-2262) against REAL Postgres — actual `ProjectMembership` rows at
// each of the three roles, resolved through the real service, never a mocked
// `resolveInputs`. The pure resolution already has an exhaustive truth table
// (`accessParity.test.ts`); what this file proves is the OTHER half — that the
// three facts the service reads out of the database are the three facts the
// policy expects, and that the DTO boundary is deterministic.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
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
    await db.project.update({ where: { id: project.id }, data: { accessLevel: 'public' } });
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

  async function projectActor(role: 'viewer' | 'member' | 'admin') {
    const u = await usersService.createUser({
      email: `${role}-${slug}@ex.com`,
      password: PASSWORD,
      name: role,
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
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
 * them when their wiring cards land.
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

/** The permissions each role holds, per access level — read off real DB rows. */
const EXPECTED: Record<ProjectAccessLevel, Record<keyof Scenario['ctxs'], PermissionKey[]>> = {
  open: {
    owner: [...ROLE_GATED_PERMISSIONS],
    wsAdmin: [...ROLE_GATED_PERMISSIONS],
    // + report:view (MOTIR-2349): the implicit workspace-member grant takes
    // exactly one of the eight — charts of a project they can already read.
    plainMember: [
      'project:browse',
      'work_item:edit',
      'comment:add',
      'attachment:create',
      'report:view',
    ],
    viewer: ['project:browse', 'report:view'],
    member: [
      'project:browse',
      'work_item:edit',
      'comment:add',
      'attachment:create',
      ...MEMBER_FACING_AT_MEMBER(),
    ],
    admin: [...ROLE_GATED_PERMISSIONS],
  },
  limited: {
    owner: [...ROLE_GATED_PERMISSIONS],
    wsAdmin: [...ROLE_GATED_PERMISSIONS],
    // view + comment, but NOT edit — the level subtracts it from a non-member.
    // `report:view` survives: `levelGrants` names only the three edit-ish keys
    // (MOTIR-2347 §3 added no branch), so every other key takes the default arm.
    plainMember: ['project:browse', 'comment:add', 'attachment:create', 'report:view'],
    viewer: ['project:browse', 'report:view'],
    member: [
      'project:browse',
      'work_item:edit',
      'comment:add',
      'attachment:create',
      ...MEMBER_FACING_AT_MEMBER(),
    ],
    admin: [...ROLE_GATED_PERMISSIONS],
  },
  private: {
    owner: [...ROLE_GATED_PERMISSIONS],
    wsAdmin: [...ROLE_GATED_PERMISSIONS],
    // Invisible without a project membership — including for `report:view`.
    plainMember: [],
    viewer: ['project:browse', 'report:view'],
    member: [
      'project:browse',
      'work_item:edit',
      'comment:add',
      'attachment:create',
      ...MEMBER_FACING_AT_MEMBER(),
    ],
    admin: [...ROLE_GATED_PERMISSIONS],
  },
  public: {
    owner: [...ROLE_GATED_PERMISSIONS, ...PUBLIC_KEYS()],
    wsAdmin: [...ROLE_GATED_PERMISSIONS, ...PUBLIC_KEYS()],
    plainMember: [
      'project:browse',
      'work_item:edit',
      'comment:add',
      'attachment:create',
      'report:view',
      ...PUBLIC_KEYS(),
    ],
    viewer: ['project:browse', 'report:view', ...PUBLIC_KEYS()],
    member: [
      'project:browse',
      'work_item:edit',
      'comment:add',
      'attachment:create',
      ...MEMBER_FACING_AT_MEMBER(),
      ...PUBLIC_KEYS(),
    ],
    admin: [...ROLE_GATED_PERMISSIONS, ...PUBLIC_KEYS()],
  },
};

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

  it('getRoleCatalog throws ProjectNotFoundError for a project in another workspace', async () => {
    const mine = await buildScenario('open', 'leak2-mine');
    const theirs = await buildScenario('open', 'leak2-theirs');
    await expect(
      projectAccessService.getRoleCatalog(theirs.projectId, mine.ctxs.owner),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('both throw ProjectNotFoundError for an id that never existed', async () => {
    const s = await buildScenario('open', 'leak3');
    await expect(
      projectAccessService.getPermissions('does-not-exist', s.ctxs.owner),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      projectAccessService.getRoleCatalog('does-not-exist', s.ctxs.owner),
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

  it('getRoleCatalog returns the three built-in roles, each with its set in catalog order', async () => {
    const s = await buildScenario('open', 'dto-catalog');
    const catalog = await projectAccessService.getRoleCatalog(s.projectId, s.ctxs.member);

    expect(catalog.roles.map((r) => r.role)).toEqual(['admin', 'member', 'viewer']);
    for (const role of catalog.roles) {
      expect(role.builtIn, `${role.role} must be marked built-in`).toBe(true);
      expect(role.labelKey).toBe(`settings.roles.${role.role}.name`);
      const positions = role.permissions.map((k) => PERMISSIONS.indexOf(k));
      expect(positions, `${role.role} permissions out of catalog order`).toEqual(
        [...positions].sort((a, b) => a - b),
      );
    }

    // The sets the grid will render, spelled out so a silent widening fails here.
    // MOTIR-2349 widened two of them ON PURPOSE — a viewer gains `report:view`,
    // a member gains six — and those are the only additions this assertion admits.
    expect([...(catalog.roles.find((r) => r.role === 'viewer')?.permissions ?? [])].sort()).toEqual(
      ['project:browse', 'report:view'].sort(),
    );
    expect([...(catalog.roles.find((r) => r.role === 'member')?.permissions ?? [])].sort()).toEqual(
      [
        'project:browse',
        'work_item:edit',
        'comment:add',
        'attachment:create',
        ...MEMBER_FACING_AT_MEMBER(),
      ].sort(),
    );
    // Compare as a SET: the DTO emits catalog order, which MOTIR-2277 changed
    // when it grouped the keys by domain. The membership is the contract, not
    // the ordering of the source constant.
    expect([...(catalog.roles.find((r) => r.role === 'admin')?.permissions ?? [])].sort()).toEqual(
      [...ROLE_GATED_PERMISSIONS].sort(),
    );

    // No role holds a level-gated public-request grant — a role cannot give one.
    for (const role of catalog.roles) {
      for (const key of role.permissions) {
        expect(key.startsWith('public_request:'), `${role.role} holds ${key}`).toBe(false);
      }
    }
  });

  it('groups every ROLE-GATED permission under a labelled, non-empty domain', async () => {
    const s = await buildScenario('open', 'dto-domains');
    const catalog = await projectAccessService.getRoleCatalog(s.projectId, s.ctxs.member);
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
    expect([...flattened].sort()).toEqual([...ROLE_GATED_PERMISSIONS].sort());
    expect(PERMISSIONS.filter((k) => !flattened.includes(k)).sort()).toEqual(
      PERMISSIONS.filter((k) => k.startsWith('public_request:')).sort(),
    );
    // Every row the screens draw is live — MOTIR-2356 wired the last key.
    expect(flattened.filter((k) => !ENFORCED_PERMISSIONS.includes(k))).toEqual([]);
    for (const domain of catalog.domains) {
      expect(domain.permissions.length, `${domain.domain} is empty`).toBeGreaterThan(0);
      expect(domain.labelKey).toBe(`permissions.domain.${domain.domain}`);
    }
    // The `M` in the list row's `N of M`, carried on the DTO so no client
    // re-derives it by importing the catalog.
    expect(catalog.roleGatedPermissionCount).toBe(ROLE_GATED_PERMISSIONS.length);
    expect(catalog.roleGatedPermissionCount).toBe(flattened.length);
    // …and the keys the role rows leave out come back on their own card, so the
    // two together are the whole catalog and nothing falls off the page.
    const levelGated = catalog.levelGatedDomains.flatMap((d) => d.permissions.map((p) => p.key));
    expect([...flattened, ...levelGated].sort()).toEqual([...PERMISSIONS].sort());
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });
});

// The per-role headcount the list row draws (Subtask MOTIR-2439) — read back
// through the service against the memberships `buildScenario` actually seeds, so
// the numbers are checked against real rows rather than against the mapper.
describe('getRoleCatalog reports each role`s member count from real memberships', () => {
  it('counts the seeded membership at each role, and only that project`s', async () => {
    const s = await buildScenario('open', 'counts');
    const other = await buildScenario('open', 'counts-other');

    const seeded = await db.projectMembership.groupBy({
      by: ['role'],
      where: { projectId: s.projectId },
      _count: { _all: true },
    });
    const expected = new Map(seeded.map((row) => [row.role, row._count._all]));

    const catalog = await projectAccessService.getRoleCatalog(s.projectId, s.ctxs.owner);
    for (const role of catalog.roles) {
      expect(role.memberCount, `${role.role} headcount`).toBe(expected.get(role.role) ?? 0);
    }
    // `buildScenario` adds exactly one project member per role on an `open`
    // project (the owner is a workspace manager, not a project membership row).
    expect(catalog.roles.map((r) => r.memberCount)).toEqual([1, 1, 1]);

    // A sibling project's memberships never leak in — the count is scoped to the
    // project asked about, not to the workspace.
    await projectMembersService.addMember({
      key: (await db.project.findUniqueOrThrow({ where: { id: other.projectId } })).identifier,
      actorUserId: other.ctxs.owner.userId,
      ctx: other.ctxs.owner,
      targetUserId: (
        await db.user.findFirstOrThrow({ where: { email: 'plain-counts-other@ex.com' } })
      ).id,
      role: 'member',
    });
    const again = await projectAccessService.getRoleCatalog(s.projectId, s.ctxs.owner);
    expect(again.roles.map((r) => r.memberCount)).toEqual([1, 1, 1]);
    expect(
      (await projectAccessService.getRoleCatalog(other.projectId, other.ctxs.owner)).roles.find(
        (r) => r.role === 'member',
      )?.memberCount,
    ).toBe(2);
  });

  it('reports 0 for a role nobody holds, rather than omitting it', async () => {
    // A `private` project auto-seeds the then-current workspace members as
    // project MEMBERS, so nothing holds `viewer` here.
    const owner = await usersService.createUser({
      email: 'solo-owner@ex.com',
      password: PASSWORD,
      name: 'Solo',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Solo WS',
      ownerUserId: owner.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Solo Project',
    });
    const catalog = await projectAccessService.getRoleCatalog(
      project.id,
      ctxFor(owner.id, workspace.id),
    );
    expect(catalog.roles.map((r) => r.role)).toEqual(['admin', 'member', 'viewer']);
    for (const role of catalog.roles) {
      expect(role.memberCount, `${role.role} must be a number, not undefined`).toBe(0);
    }
  });

  it('gates BEFORE it counts — a foreign project 404s rather than reading memberships', async () => {
    const mine = await buildScenario('open', 'count-gate-mine');
    const theirs = await buildScenario('open', 'count-gate-theirs');
    // The membership rows exist and are non-zero; the guard is what stops the
    // read, not an empty result.
    expect(
      (await projectAccessService.getRoleCatalog(theirs.projectId, theirs.ctxs.owner)).roles.some(
        (r) => r.memberCount > 0,
      ),
    ).toBe(true);
    await expect(
      projectAccessService.getRoleCatalog(theirs.projectId, mine.ctxs.owner),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

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
