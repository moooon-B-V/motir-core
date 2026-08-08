import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectAccessLevel } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { PERMISSIONS, type PermissionKey } from '@/lib/permissions/catalog';
import { ROLE_GATED_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { toRoleCatalogDTO } from '@/lib/mappers/permissionMappers';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// THE STORY GATE for MOTIR-2282 (Subtask MOTIR-2264) — run against the merged
// surface of the story's cards, doing the three things a per-card unit test
// structurally cannot.
//
// The per-card suites each mock the other side of every seam they touch; this
// file mocks nothing. Real Postgres, real memberships, real service.

const PASSWORD = 'hunter2hunter2';
const REPO_ROOT = join(import.meta.dirname, '..', '..');

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

type Persona = 'owner' | 'wsAdmin' | 'stranger' | 'viewer' | 'member' | 'admin';

interface Scenario {
  projectId: string;
  ctxs: Record<Persona, WorkspaceContext>;
}

async function buildScenario(level: ProjectAccessLevel, slug: string): Promise<Scenario> {
  const owner = await usersService.createUser({
    email: `g-owner-${slug}@ex.com`,
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
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };

  if (level === 'public') {
    await db.project.update({ where: { id: project.id }, data: { accessLevel: 'public' } });
  } else {
    await projectMembersService.setAccessLevel({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level,
    });
  }

  async function workspaceUser(name: string, role?: 'admin') {
    const user = await usersService.createUser({
      email: `g-${name}-${slug}@ex.com`,
      password: PASSWORD,
      name,
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: workspace.id, role });
    return user;
  }
  const wsAdmin = await workspaceUser('wsadmin', 'admin');
  const stranger = await workspaceUser('stranger');

  async function projectActor(role: 'viewer' | 'member' | 'admin') {
    const user = await workspaceUser(role);
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: user.id,
      role,
    });
    return user;
  }
  const viewer = await projectActor('viewer');
  const member = await projectActor('member');
  const admin = await projectActor('admin');

  return {
    projectId: project.id,
    ctxs: {
      owner: ownerCtx,
      wsAdmin: { userId: wsAdmin.id, workspaceId: workspace.id },
      stranger: { userId: stranger.id, workspaceId: workspace.id },
      viewer: { userId: viewer.id, workspaceId: workspace.id },
      member: { userId: member.id, workspaceId: workspace.id },
      admin: { userId: admin.id, workspaceId: workspace.id },
    },
  };
}

const LEVELS: ProjectAccessLevel[] = ['open', 'limited', 'private', 'public'];
const PERSONAS: Persona[] = ['owner', 'wsAdmin', 'stranger', 'viewer', 'member', 'admin'];

// ═══════════════════════════════════════════════════════════════════════════
// 2 · THE INTEGRATION SEAMS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE AGREEMENT MATRIX — the seam nothing else in the codebase compares.
 *
 * Seven capability methods answer access questions today and `getPermissions`
 * answers the general version. Each specialised method could drift from the
 * general one the first time somebody touches it, and the failure would look
 * like "comments behave differently from attachments for a viewer on a limited
 * project" — the kind of bug that gets explained away as intended rather than
 * found. So every boolean is asserted to be true exactly when its permission key
 * is in the set, for every persona on every access level.
 *
 * ⚠️ THE MAP IS WRITTEN OUT, not derived from the methods. Deriving the
 * expectation from the thing under test proves only that it equals itself.
 */
const AGREEMENT: {
  method: keyof typeof projectAccessService;
  booleans: Record<string, PermissionKey>;
}[] = [
  {
    method: 'getCapabilities',
    booleans: { canBrowse: 'project:browse', canEdit: 'work_item:edit' },
  },
  {
    method: 'getCommentCapabilities',
    booleans: {
      canBrowse: 'project:browse',
      canComment: 'comment:add',
      canModerate: 'comment:moderate',
    },
  },
  {
    method: 'getAttachmentCapabilities',
    booleans: {
      canBrowse: 'project:browse',
      canCreate: 'attachment:create',
      canDeleteAll: 'attachment:delete_any',
    },
  },
  {
    method: 'getWatcherCapabilities',
    booleans: { canBrowse: 'project:browse', canManageWatchers: 'watcher:manage' },
  },
  {
    method: 'getSavedFilterCapabilities',
    // `canShare` is the shipped EDIT tier by construction (publishing into the
    // project's shared namespace is a write); `isAdmin` is a role question the
    // catalog does not model, so it is deliberately not in this map.
    booleans: { canBrowse: 'project:browse', canShare: 'work_item:edit' },
  },
  {
    method: 'getSettingsCapabilities',
    booleans: {
      canBrowse: 'project:browse',
      canEdit: 'work_item:edit',
      canManage: 'project:administer',
    },
  },
  {
    method: 'getManageCapabilities',
    booleans: { canBrowse: 'project:browse', canManage: 'project:administer' },
  },
];

describe('the capability methods and getPermissions agree, on every level and every persona', () => {
  for (const level of LEVELS) {
    it(`agrees on a ${level} project`, async () => {
      const s = await buildScenario(level, `agree-${level}`);
      for (const persona of PERSONAS) {
        const ctx = s.ctxs[persona];
        const held = await projectAccessService.getPermissions(s.projectId, ctx);
        for (const { method, booleans } of AGREEMENT) {
          const caps = (await (
            projectAccessService[method] as (
              projectId: string,
              ctx: WorkspaceContext,
            ) => Promise<Record<string, unknown>>
          )(s.projectId, ctx)) as Record<string, boolean>;
          for (const [field, key] of Object.entries(booleans)) {
            expect(caps[field], `${level}/${persona}: ${String(method)}.${field} vs ${key}`).toBe(
              held.has(key),
            );
          }
        }
      }
    });
  }
});

describe('the widened DTO survives the round trip through real rows', () => {
  it("reports each role's real headcount and the two groupings still cover the catalog", async () => {
    const s = await buildScenario('open', 'seam-dto');
    const catalog = await projectAccessService.getRoleCatalog(s.projectId, s.ctxs.owner);

    const seeded = await db.projectMembership.groupBy({
      by: ['role'],
      where: { projectId: s.projectId },
      _count: { _all: true },
    });
    const expected = new Map(seeded.map((row) => [row.role, row._count._all]));
    for (const role of catalog.roles) {
      expect(role.memberCount, `${role.role}`).toBe(expected.get(role.role) ?? 0);
    }

    // The screens' own contract, read off the SERVICE rather than the mapper.
    const rows = catalog.domains.flatMap((group) => group.permissions.map((p) => p.key));
    const levelGated = catalog.levelGatedDomains.flatMap((g) => g.permissions.map((p) => p.key));
    expect([...rows].sort()).toEqual([...ROLE_GATED_PERMISSIONS].sort());
    expect([...rows, ...levelGated].sort()).toEqual([...PERMISSIONS].sort());
    expect(catalog.roleGatedPermissionCount).toBe(rows.length);
  });

  it("a role's marks are exactly the set getPermissions resolves for a real actor of that role", async () => {
    // The DETAIL screen marks a row `held` when the key is in `role.permissions`.
    // On an `open` project a project member's resolved set is their role's set —
    // so the marks a real member would see are the capabilities they really have.
    const s = await buildScenario('open', 'seam-marks');
    const catalog = await projectAccessService.getRoleCatalog(s.projectId, s.ctxs.member);
    const memberRole = catalog.roles.find((role) => role.role === 'member')!;
    const held = await projectAccessService.getPermissions(s.projectId, s.ctxs.member);
    for (const key of ROLE_GATED_PERMISSIONS) {
      expect(memberRole.permissions.includes(key), `member mark for ${key}`).toBe(held.has(key));
    }
  });

  it('is JSON-serialisable end to end — no Set reaches a Server Component prop', async () => {
    const s = await buildScenario('limited', 'seam-json');
    const catalog = await projectAccessService.getRoleCatalog(s.projectId, s.ctxs.admin);
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });
});

describe('the public path resolves for a genuinely anonymous actor', () => {
  it('grants browse and the three request writes with a null actor, through the service', async () => {
    const s = await buildScenario('public', 'anon');
    const caps = await projectAccessService.getPublicCapabilities(s.projectId, null);
    expect(caps).toEqual({
      canBrowse: true,
      canSubmitToTriage: true,
      canUpvotePublicRequest: true,
      canCommentPublicRequest: true,
    });
  });

  it('hides a non-public project from an anonymous actor as a 404, never a 403', async () => {
    const s = await buildScenario('open', 'anon-hidden');
    await expect(
      projectAccessService.getPublicCapabilities(s.projectId, null),
    ).rejects.toMatchObject({ name: 'ProjectNotFoundError' });
  });

  it('the three request grants are exactly the level-gated card the role list draws', async () => {
    // The screens explain `public_request:*` as level-granted rather than
    // role-granted. This is the same claim, checked against the service.
    const s = await buildScenario('public', 'anon-card');
    const levelGated = toRoleCatalogDTO()
      .levelGatedDomains.flatMap((group) => group.permissions.map((p) => p.key))
      .sort();
    expect(levelGated).toEqual(
      PERMISSIONS.filter((key) => key.startsWith('public_request:')).sort(),
    );
    // …and no ROLE grants one, on the very level where everybody holds them.
    for (const persona of PERSONAS) {
      const held = await projectAccessService.getPermissions(s.projectId, s.ctxs[persona]);
      const catalog = await projectAccessService.getRoleCatalog(s.projectId, s.ctxs[persona]);
      for (const role of catalog.roles) {
        expect(role.permissions.some((key) => key.startsWith('public_request:'))).toBe(false);
      }
      // The actor DOES hold them — from the level, which is the whole point.
      for (const key of levelGated) expect(held.has(key), `${persona} ${key}`).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 · THE ARCHITECTURE GUARDS — what a coverage percentage cannot see.
//
// Each guard below is paired with a NEGATIVE case that runs its own detector
// over a deliberately-violating fixture string. A guard nobody has watched fail
// is a guard nobody knows is wired up.
// ═══════════════════════════════════════════════════════════════════════════

/** Every `.ts`/`.tsx` under `dir`, recursively, as `[relativePath, source]`. */
function sourcesUnder(dir: string): [string, string][] {
  const out: [string, string][] = [];
  const walk = (absolute: string) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const next = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        walk(next);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push([next.slice(REPO_ROOT.length + 1), readFileSync(next, 'utf8')]);
      }
    }
  };
  walk(join(REPO_ROOT, dir));
  return out;
}

/**
 * The VALUE imports of a source file — every `import …` statement that is not
 * `import type …`.
 *
 * ⚠️ THE TYPE/VALUE DISTINCTION IS THE WHOLE POINT, and both guards below learnt
 * it the hard way: their first drafts flagged `PermissionGroups.tsx` and
 * `lib/permissions/resolve.ts`, each of which imports a TYPE and nothing else. A
 * type import is erased at compile time — it creates no runtime coupling, no
 * bundle edge and no way to re-derive anything. Flagging one would have made the
 * guards read as violated by files that are exactly right, which is how a guard
 * gets relaxed until it protects nothing.
 */
function valueImports(source: string): string {
  return source
    .split('\n')
    .filter((line) => /^\s*import\b/.test(line) && !/^\s*import\s+type\b/.test(line))
    .join('\n');
}

/** The detector behind the "no component re-derives the model" guard. */
const IMPORTS_THE_MODEL = /from '@\/lib\/permissions\/(catalog|builtinRoles|resolve)'/;

describe('guard — the settings screens read the SERVICE, never the model', () => {
  const SCREENS = 'app/(authed)/settings/project/roles';

  it('no file under the roles screens imports the catalog or the role sets', () => {
    const offenders = sourcesUnder(SCREENS)
      .filter(([, source]) => IMPORTS_THE_MODEL.test(valueImports(source)))
      .map(([path]) => path);
    // A component wired to the constants is the one that quietly stops working
    // the day MOTIR-2257 makes the answer project-scoped — the whole reason the
    // read goes through a service at all.
    expect(offenders).toEqual([]);
    // The guard is only meaningful if it is looking at files.
    expect(sourcesUnder(SCREENS).length).toBeGreaterThan(3);
  });

  it('…and the detector FAILS on a file that does import it', () => {
    expect(
      IMPORTS_THE_MODEL.test(
        valueImports("import { PERMISSIONS } from '@/lib/permissions/catalog';"),
      ),
    ).toBe(true);
    // A TYPE import of the same module is fine and must NOT trip it — this is
    // the exact shape that made the guard's first draft fire on a correct file.
    expect(
      IMPORTS_THE_MODEL.test(
        valueImports("import type { PermissionKey } from '@/lib/permissions/catalog';"),
      ),
    ).toBe(false);
    expect(
      IMPORTS_THE_MODEL.test(valueImports("import type { RoleDTO } from '@/lib/dto/permissions';")),
    ).toBe(false);
  });

  it('the screens do consume the DTO, so the guard is not passing by rendering nothing', () => {
    const consumesDto = sourcesUnder(SCREENS).some(([, source]) =>
      /from '@\/lib\/dto\/permissions'/.test(source),
    );
    expect(consumesDto).toBe(true);
  });
});

/** The detector behind the "no inline role comparison" guard. */
const INLINE_ROLE_COMPARISON =
  /\b(?:projectRole|role|memberRole)\s*(?:===|!==)\s*['"](?:admin|member|viewer|owner)['"]/;

describe('guard — access is decided by the predicates, never by an inline role string', () => {
  it('the roles screens decide nothing by comparing a role string', () => {
    const offenders = sourcesUnder('app/(authed)/settings/project/roles')
      .filter(([, source]) => INLINE_ROLE_COMPARISON.test(source))
      .map(([path]) => path);
    // An inline comparison is a policy the catalog cannot see and a custom role
    // cannot change.
    expect(offenders).toEqual([]);
  });

  it('…and the detector FAILS on the shape it is looking for', () => {
    expect(INLINE_ROLE_COMPARISON.test("if (membership.role === 'admin') return true;")).toBe(true);
    expect(INLINE_ROLE_COMPARISON.test('if (isWorkspaceManager(role)) return true;')).toBe(false);
  });
});

/** The detector behind the "the pure layer stays pure" guard. */
const IMPURE =
  /from '@\/lib\/db'|from '@prisma\/client'|from '@\/generated\/prisma|['"]server-only['"]/;

describe('guard — the permission model stays a pure, importable leaf', () => {
  it('lib/permissions/* and lib/projects/access.ts touch no Prisma client and no IO', () => {
    const files = [
      ...sourcesUnder('lib/permissions'),
      [
        'lib/projects/access.ts',
        readFileSync(join(REPO_ROOT, 'lib/projects/access.ts'), 'utf8'),
      ] as [string, string],
    ];
    const offenders = files
      .filter(([, source]) => IMPURE.test(valueImports(source)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(2);
  });

  it('…and the detector FAILS on an impure import', () => {
    expect(IMPURE.test(valueImports("import { db } from '@/lib/db';"))).toBe(true);
    expect(IMPURE.test(valueImports("import { PrismaClient } from '@prisma/client';"))).toBe(true);
    // `import type { MemberRole } from '@/generated/prisma/client'` is what
    // `resolve.ts` does, and it is PURE — the enum type is erased.
    expect(
      IMPURE.test(valueImports("import type { MemberRole } from '@/generated/prisma/client';")),
    ).toBe(false);
  });
});

describe('guard — both i18n catalogs stay total over the ROLE-GATED keys', () => {
  const CATALOGS = {
    en: JSON.parse(readFileSync(join(REPO_ROOT, 'messages/en.json'), 'utf8')),
    zh: JSON.parse(readFileSync(join(REPO_ROOT, 'messages/zh.json'), 'utf8')),
  } as Record<string, Record<string, Record<string, Record<string, string> | string>>>;

  function lookup(catalog: unknown, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>(
        (node, segment) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[segment] : undefined,
        catalog,
      );
  }

  it('every row the screens draw has a label and a description in both locales', () => {
    const rows = toRoleCatalogDTO().domains.flatMap((group) => group.permissions);
    expect(rows.length).toBe(ROLE_GATED_PERMISSIONS.length);
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const row of rows) {
        expect(lookup(catalog, row.labelKey), `${locale} ${row.labelKey}`).toBeTruthy();
        expect(lookup(catalog, row.descriptionKey), `${locale} ${row.descriptionKey}`).toBeTruthy();
      }
    }
  });

  it('every DOMAIN heading and every role identity resolves in both locales', () => {
    const catalog = toRoleCatalogDTO();
    for (const [locale, messages] of Object.entries(CATALOGS)) {
      for (const group of [...catalog.domains, ...catalog.levelGatedDomains]) {
        expect(lookup(messages, group.labelKey), `${locale} ${group.labelKey}`).toBeTruthy();
      }
      for (const role of catalog.roles) {
        expect(lookup(messages, role.labelKey), `${locale} ${role.labelKey}`).toBeTruthy();
        expect(
          lookup(messages, role.descriptionKey),
          `${locale} ${role.descriptionKey}`,
        ).toBeTruthy();
      }
      // The screens' own strings, by the keys the components actually pass.
      for (const key of [
        'settings.nav.roles',
        'settings.rolesPage.title',
        'settings.rolesPage.subtitle',
        'settings.rolesPage.builtInNote',
        'settings.rolesPage.builtIn',
        'settings.rolesPage.builtInLocked',
        'settings.rolesPage.permissionCount',
        'settings.rolesPage.memberCount',
        'settings.rolesPage.allRoles',
        'settings.rolesPage.crumbs',
        'settings.rolesPage.holdsCount',
        'settings.rolesPage.mark.held',
        'settings.rolesPage.mark.notHeld',
        'settings.rolesPage.mark.levelGranted',
        'settings.rolesPage.levelGated.title',
        'settings.rolesPage.levelGated.description',
        'settings.rolesPage.levelGated.chip',
      ]) {
        expect(lookup(messages, key), `${locale} ${key}`).toBeTruthy();
      }
    }
  });

  it('…and the lookup FAILS on a key neither catalog has', () => {
    expect(lookup(CATALOGS.en, 'settings.rolesPage.thisDoesNotExist')).toBeUndefined();
  });
});
