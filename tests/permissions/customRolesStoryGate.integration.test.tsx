// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cleanup, screen, within } from '@testing-library/react';
import { renderWithIntl } from '../helpers/renderWithIntl';
import { db } from '@/lib/db';
import type { Prisma } from '@/generated/prisma/client';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { runAsCloudBuild } from '../helpers/cloudBuild';

// SEAM 5 loops over EVERY access level, `public` included — and publishing is a
// cloud-only capability since Story MOTIR-3908, refused on the self-hosted build
// a Vitest run is by default. The seam's claim is that a custom role grants the
// same on every level, which is a claim about the level SET, so the arm to assert
// it on is the build where all four exist (MOTIR-4037).
runAsCloudBuild();

// ═══════════════════════════════════════════════════════════════════════════
// THE STORY GATE — custom project roles (Story MOTIR-2257 · Subtask MOTIR-2486)
// ═══════════════════════════════════════════════════════════════════════════
//
// Nine cards each shipped their own tests, and every one of them can be green
// while the feature is broken. That is not a criticism of those tests — it is
// what a unit test IS: each card proves its own piece works when handed the
// input it expects, and each one builds that input itself. A feature breaks
// between two pieces, where one card's output meets another card's assumption
// about it, and nobody's tests look there.
//
// So this file does the two things no individual card can:
//
//   1. THE SEAMS. Each drives one card's REAL output through the next card's
//      REAL consumer. Never a hand-built fixture standing in for a producer —
//      the whole point is to catch the key drift a fixture would paper over.
//   2. THE GUARDS. Properties of the CODEBASE rather than of a run: that there
//      is exactly one way to write which role a member holds, that a stale
//      stored key cannot widen access, that the pure modules stay pure, and
//      that a foreign workspace sees nothing. A coverage number cannot see any
//      of these, and each is a rule a future card could break while passing
//      every test it wrote for itself.
//
// ⚠️ happy-dom + REAL POSTGRES in one file, deliberately. Two of the seams end
// at a SCREEN — a stored row read out through `getRoleCatalog` and rendered by
// the component that consumes the DTO — and a seam test that stopped at the DTO
// and compared it to a fixture would be exactly the test this file exists to
// replace. `tests/components/ConnectCliPanel.test.tsx` already pairs the two.
//
// ⚠️ ONE DEVIATION FROM THE CARD, and it is a decision that landed after the
// card was written: the card's seam #2 asks the rendered row to show a
// `Based on … · ±N` chip. Nothing records what a role was seeded from any more
// (Yue, 2026-08-09) — `Start from` is an authoring convenience that is not sent,
// not stored and not drawn. The seam is asserted on what the row DOES carry:
// the role's own name, its `N of M permissions`, and its member count.

// ⚠️ THE RESOLUTION HALF OF THIS GATE RETIRED WITH PROJECT ROLES (Story MOTIR-6168
// · MOTIR-6459, `docs/decisions/role-model.md` §3). A project custom role still
// has its screens and routes until MOTIR-6466 / MOTIR-6464 move and retire them,
// so the SCREEN and ROUTE seams below stand. What it no longer does is GRANT: a
// person's keys come from their WORKSPACE role, so SEAM 1 now asserts exactly
// that, and the seams that ended at "…and the person resolves to the role's set"
// (SEAM 4's resolution, SEAM 5's per-level table, the stale-key guard) moved to
// the workspace custom role, where they are proven against real Postgres in
// `tests/permissions/getPermissions.integration.test.ts`.

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { projectsService } = await import('@/lib/services/projectsService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { projectRoleDefinitionService } =
  await import('@/lib/services/projectRoleDefinitionService');
const { projectRoleDefinitionRepository } =
  await import('@/lib/repositories/projectRoleDefinitionRepository');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { WORKSPACE_ROLE_PERMISSIONS } = await import('@/lib/permissions/builtinRoles');
const { RoleList } = await import('@/app/(authed)/settings/project/roles/_components/RoleList');
const { RoleDetail } = await import('@/app/(authed)/settings/project/roles/_components/RoleDetail');
const { POST: rolesPOST } = await import('@/app/api/projects/[key]/roles/route');
const { PATCH: rolePATCH } = await import('@/app/api/projects/[key]/roles/[roleId]/route');
const { truncateAuthTables } = await import('../helpers/db');

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  ctxRef.current = null;
  await truncateAuthTables();
});
afterEach(() => cleanup());
afterAll(async () => {
  await db.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  ownerId: string;
  ownerCtx: WorkspaceContext;
}

async function build(slug: string, projectName = `Project ${slug}`): Promise<Fixture> {
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
    name: projectName,
  });
  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    ownerId: owner.id,
    ownerCtx: { userId: owner.id, workspaceId: workspace.id },
  };
}

/** A new workspace member, added to the project at a built-in role. */
async function seatMember(fx: Fixture, slug: string, role: string) {
  const user = await usersService.createUser({
    email: `${slug}@ex.com`,
    password: PASSWORD,
    name: slug,
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await projectMembersService.addMember({
    key: fx.projectKey,
    actorUserId: fx.ownerId,
    ctx: fx.ownerCtx,
    targetUserId: user.id,
    role,
  });
  return user;
}

function authorRole(fx: Fixture, name: string, permissions: PermissionKey[]) {
  return projectRoleDefinitionService.create({
    projectId: fx.projectId,
    ctx: fx.ownerCtx,
    name,
    permissions,
  });
}

function assign(fx: Fixture, userId: string, roleKey: string) {
  return projectMembersService.setRole({
    key: fx.projectKey,
    actorUserId: fx.ownerId,
    ctx: fx.ownerCtx,
    targetUserId: userId,
    role: roleKey,
  });
}

/**
 * Run `fn` under the NON-BYPASS `motir_app` role, with the workspace GUC bound
 * — the only way an RLS assertion means anything here, since the test connection
 * is the superuser and a superuser bypasses every policy. A local copy, per the
 * convention each RLS-touching suite in this repo carries its own.
 */
async function asAppRole<T>(
  ctx: { workspaceId: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

function resolvedFor(fx: Fixture, userId: string) {
  return projectAccessService.getPermissions(fx.projectId, {
    userId,
    workspaceId: fx.workspaceId,
  });
}

// ═══════════════════════════════ THE SEAMS ═══════════════════════════════

describe('SEAM 1 · author → assign → resolve', () => {
  it('an authored PROJECT role grants nothing any more — the person resolves by their WORKSPACE role (MOTIR-6459)', async () => {
    const fx = await build('seam1');
    const nadia = await seatMember(fx, 'nadia-seam1', 'member');

    const composed: PermissionKey[] = ['project:browse', 'comment:add', 'report:view'];
    const role = await authorRole(fx, 'Contractor', composed);
    await assign(fx, nadia.id, role.id);

    // The assignment still lands on the row the screens read…
    const members = await projectMembersService.listMembers({
      key: fx.projectKey,
      actorUserId: fx.ownerId,
      ctx: fx.ownerCtx,
    });
    expect(members.find((m) => m.userId === nadia.id)?.roleDefinition?.id).toBe(role.id);
    // …and decides nothing: Nadia holds exactly her workspace role's set.
    const resolved = await resolvedFor(fx, nadia.id);
    expect([...resolved].sort()).toEqual([...WORKSPACE_ROLE_PERMISSIONS.member].sort());
  });
});

describe('SEAM 2 · store → read → SCREEN', () => {
  it('a stored role reaches the list row as its own name, its count and its holders', async () => {
    const fx = await build('seam2');
    const holder = await seatMember(fx, 'holder-seam2', 'member');
    const role = await authorRole(fx, 'Contractor', ['project:browse', 'comment:add']);
    await assign(fx, holder.id, role.id);

    // The screen's OWN read — not a fixture shaped like one.
    const catalog = await projectRoleDefinitionService.getRoleCatalog(fx.projectId, fx.ownerCtx);
    renderWithIntl(<RoleList catalog={catalog} />);

    // The role's name is text its author typed; it must arrive verbatim and never
    // through a translation lookup.
    const row = screen.getByRole('link', { name: /Contractor/ });
    expect(within(row).getByText('Custom')).toBeTruthy();
    expect(row.textContent).toContain(`2 of ${catalog.roleGatedPermissionCount} permissions`);
    // The member count is a fact about ProjectMembership that travelled the whole
    // way through the grouped read into the row.
    expect(row.textContent).toContain('1 member');
    // The three built-ins are still drawn beside it, unchanged.
    for (const name of ['Admin', 'Member', 'Viewer']) {
      expect(screen.getByRole('link', { name: new RegExp(name) })).toBeTruthy();
    }
  });

  it('the DETAIL screen renders the stored set — the permission the role withholds is drawn as withheld', async () => {
    const fx = await build('seam2b');
    const role = await authorRole(fx, 'Contractor', ['project:browse', 'comment:add']);
    const catalog = await projectRoleDefinitionService.getRoleCatalog(fx.projectId, fx.ownerCtx);
    const dto = catalog.roles.find((r) => r.key === role.id)!;

    const { container } = renderWithIntl(
      <RoleDetail role={dto} catalog={catalog} projectName="Motir" />,
    );

    // Read back through the component's own output: the DTO's keys are what the
    // grid marks, so a key spelled differently on either side of the mapper shows
    // up here as a row marked the wrong way — which no fixture-based test of the
    // DTO could tell apart from a correct one.
    function markOf(key: string): string | null {
      const row = container.querySelector(`li[data-permission="${key}"]`);
      return row?.querySelector('[data-mark]')?.getAttribute('data-mark') ?? null;
    }
    expect(markOf('project:browse')).toBe('held');
    expect(markOf('comment:add')).toBe('held');
    expect(markOf('sprint:manage')).toBe('withheld');
    // And the row is labelled in words, not only by a glyph's colour.
    expect(screen.getAllByRole('img', { name: 'Held' })).toHaveLength(2);
  });
});

describe('SEAM 3 · editor payload → real route → store → read', () => {
  it('the body the editor sends round-trips to the row the list reads', async () => {
    const fx = await build('seam3');
    ctxRef.current = fx.ownerCtx;

    // ⚠️ THE EDITOR'S ACTUAL BODY — `{ name, permissions }`, no `basedOn`. If the
    // route ever grew a required field the editor does not send, this fails here
    // rather than in a browser.
    const created = await rolesPOST(
      new Request('http://t/api/projects/x/roles', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Contractor',
          permissions: ['comment:add', 'project:browse'],
        }),
      }),
      { params: Promise.resolve({ key: fx.projectKey }) },
    );
    expect(created.status).toBe(201);
    const { role } = (await created.json()) as { role: { id: string; permissions: string[] } };

    // Out through the READ the screens use — a different code path from the write
    // response, which is the point: the two have to agree.
    const catalog = await projectRoleDefinitionService.getRoleCatalog(fx.projectId, fx.ownerCtx);
    const stored = catalog.roles.find((r) => r.key === role.id)!;
    expect(stored.name).toBe('Contractor');
    expect(stored.builtIn).toBe(false);
    expect(stored.permissions).toEqual(role.permissions);

    // And the same body shape on the EDIT verb, partial in each direction.
    const renamed = await rolePATCH(
      new Request('http://t/api/projects/x/roles/y', {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Contractor (EU)' }),
      }),
      { params: Promise.resolve({ key: fx.projectKey, roleId: role.id }) },
    );
    expect(renamed.status).toBe(200);
    const repermissioned = await rolePATCH(
      new Request('http://t/api/projects/x/roles/y', {
        method: 'PATCH',
        body: JSON.stringify({ permissions: ['project:browse'] }),
      }),
      { params: Promise.resolve({ key: fx.projectKey, roleId: role.id }) },
    );
    expect(repermissioned.status).toBe(200);

    const after = await projectRoleDefinitionService.getRoleCatalog(fx.projectId, fx.ownerCtx);
    const final = after.roles.find((r) => r.key === role.id)!;
    // A name-only patch left the set alone and a permissions-only patch left the
    // name alone — each verb touches what it names and nothing else.
    expect(final.name).toBe('Contractor (EU)');
    expect(final.permissions).toEqual(['project:browse']);
  });
});

describe('SEAM 4 · delete → reassign → resolve', () => {
  it('every mover’s RESOLVED permissions become the destination’s — not merely a column that moved', async () => {
    const fx = await build('seam4');
    const [x, y] = await Promise.all([
      seatMember(fx, 'x-seam4', 'member'),
      seatMember(fx, 'y-seam4', 'member'),
    ]);
    const doomed = await authorRole(fx, 'Contractor', ['project:browse', 'comment:add']);
    const destination = await authorRole(fx, 'Reader', ['project:browse', 'report:view']);
    await assign(fx, x.id, doomed.id);
    await assign(fx, y.id, doomed.id);

    await projectRoleDefinitionService.delete({
      projectId: fx.projectId,
      roleId: doomed.id,
      ctx: fx.ownerCtx,
      reassignTo: destination.id,
    });

    // Every mover now points at the destination (what they can DO is their
    // workspace role's since MOTIR-6459, proven in getPermissions.integration).
    const members = await projectMembersService.listMembers({
      key: fx.projectKey,
      actorUserId: fx.ownerId,
      ctx: fx.ownerCtx,
    });
    for (const mover of [x, y]) {
      expect(members.find((m) => m.userId === mover.id)?.roleDefinition?.id).toBe(destination.id);
    }
    // The role itself is gone from the catalog the screens read.
    const catalog = await projectRoleDefinitionService.getRoleCatalog(fx.projectId, fx.ownerCtx);
    expect(catalog.roles.map((r) => r.key)).not.toContain(doomed.id);
    expect(catalog.roles.find((r) => r.key === destination.id)?.memberCount).toBe(2);
  });

  it('a BUILT-IN destination puts the movers back on that tier, pointer cleared', async () => {
    const fx = await build('seam4b');
    const z = await seatMember(fx, 'z-seam4b', 'member');
    const doomed = await authorRole(fx, 'Contractor', ['project:browse']);
    await assign(fx, z.id, doomed.id);

    await projectRoleDefinitionService.delete({
      projectId: fx.projectId,
      roleId: doomed.id,
      ctx: fx.ownerCtx,
      reassignTo: 'viewer',
    });

    const members = await projectMembersService.listMembers({
      key: fx.projectKey,
      actorUserId: fx.ownerId,
      ctx: fx.ownerCtx,
    });
    const row = members.find((m) => m.userId === z.id);
    expect(row?.role).toBe('viewer');
    expect(row?.roleDefinition).toBeNull();
  });
});

describe('SEAM 5 · the access level, against real Postgres', () => {
  // The per-level custom-role table moved to the WORKSPACE custom role
  // (getPermissions.integration, MOTIR-6459). The level rail's own control stays.
  it('the level rail is INTACT beside it — a non-member still loses work_item:edit on `limited`', async () => {
    // The control for the test above. Without it, "the level subtracted nothing"
    // would be equally consistent with a resolution where the level subtracts
    // nothing from ANYONE — i.e. with the rail being broken outright.
    //
    // ⚠️ THE ACTOR HERE HAS NO PROJECT MEMBERSHIP, and that is the whole point:
    // `limited` withholds `work_item:edit` from a workspace member who is not ON
    // the project ("view + comment for any workspace member; only project members
    // edit"). A project `member` keeps it at every level, so a membership-holder
    // would have proved nothing.
    const fx = await build('seam5b');
    const sam = await usersService.createUser({
      email: 'sam-seam5b@ex.com',
      password: PASSWORD,
      name: 'Sam',
    });
    await workspacesService.addMember({ userId: sam.id, workspaceId: fx.workspaceId });

    await projectMembersService.setAccessLevel({
      key: fx.projectKey,
      actorUserId: fx.ownerId,
      ctx: fx.ownerCtx,
      level: 'open',
    });
    expect((await resolvedFor(fx, sam.id)).has('work_item:edit')).toBe(true);

    await projectMembersService.setAccessLevel({
      key: fx.projectKey,
      actorUserId: fx.ownerId,
      ctx: fx.ownerCtx,
      level: 'limited',
    });
    expect((await resolvedFor(fx, sam.id)).has('work_item:edit')).toBe(false);
  });
});

// ═══════════════════════════════ THE GUARDS ═══════════════════════════════

describe('GUARD · one write path for role_definition_id', () => {
  // A property of the CODEBASE, not of a run. `role` is a tier and
  // `role_definition_id` is the pointer, and a membership is only ever coherent
  // when the two are written in the SAME statement. A future card that added a
  // parallel writer would pass every test it wrote for itself and leave members
  // whose screens and whose permissions disagree.
  const LIB = join(process.cwd(), 'lib');

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      return statSync(full).isDirectory()
        ? walk(full)
        : full.endsWith('.ts') || full.endsWith('.tsx')
          ? [full]
          : [];
    });
  }

  it('nothing under lib/ writes the column except the two membership repositories', () => {
    // The workspace membership carries its own pointer since MOTIR-6457, with its
    // own single writer (`setWorkspaceRole`), held to the same pairing below.
    const writers = walk(LIB)
      .filter((file) => /data:\s*\{[^}]*roleDefinitionId/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file))
      .sort();
    expect(writers).toEqual([
      'lib/repositories/projectMembershipRepository.ts',
      'lib/repositories/workspaceMembershipRepository.ts',
    ]);
  });

  it('the WORKSPACE repository writes it in exactly one place, paired with the workspace role', () => {
    const source = readFileSync(join(LIB, 'repositories/workspaceMembershipRepository.ts'), 'utf8');
    const writes = [...source.matchAll(/data:\s*\{[^}]*roleDefinitionId[^}]*\}/g)].map((m) => m[0]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('workspaceRole:');
  });

  it('the repository writes it in exactly two places, each pairing it with the tier', () => {
    const source = readFileSync(join(LIB, 'repositories/projectMembershipRepository.ts'), 'utf8');
    const writes = [...source.matchAll(/data:\s*\{[^}]*roleDefinitionId[^}]*\}/g)].map((m) => m[0]);
    expect(writes).toHaveLength(2);
    for (const write of writes) expect(write).toContain('role:');
  });
});

describe('GUARD · the pure modules stay pure', () => {
  // These three load in a server component, a client bundle and a bare test. A
  // Prisma import would drag the client into a browser bundle; a React import
  // would make the policy unloadable from a plain node script. Both are the kind
  // of change that looks harmless in the file it happens in.
  const PURE = [
    'lib/permissions/resolve.ts',
    'lib/permissions/catalog.ts',
    'lib/permissions/limits.ts',
  ];

  it.each(PURE)('%s pulls neither Prisma nor React into a bundle', (file) => {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    // ⚠️ `import type` IS ALLOWED and is not a loophole. A type-only import is
    // ERASED at compile time, so `import type { MemberRole } from
    // '@/generated/prisma/client'` puts nothing in a bundle and costs nothing at
    // load — it is how these modules name Prisma's enums without depending on
    // Prisma. What the guard forbids is a VALUE import, which does both.
    const valueImports = [...source.matchAll(/^\s*import\s+(?!type\s)[^;]*?from\s+'([^']+)'/gm)]
      .map((m) => m[1]!)
      .filter(
        (specifier) =>
          /prisma|@\/lib\/db/i.test(specifier) ||
          specifier === 'react' ||
          specifier === 'react-dom',
      );
    expect({ file, valueImports }).toEqual({ file, valueImports: [] });
  });

  it('lib/permissions/limits.ts imports NOTHING at all — the cap is a number, not a module graph', () => {
    const source = readFileSync(join(process.cwd(), 'lib/permissions/limits.ts'), 'utf8');
    expect(/^\s*import\s/m.test(source)).toBe(false);
  });
});

describe('GUARD · tenancy at the non-bypass app role', () => {
  it('a foreign workspace GUC sees no role definitions, counts none, and cannot write one', async () => {
    const mine = await build('guard-mine', 'Alpha');
    const theirs = await build('guard-theirs', 'Beta');
    const role = await authorRole(mine, 'Contractor', ['project:browse']);

    // ⚠️ AT THE NON-BYPASS ROLE, WHICH IS THE WHOLE POINT. The test connection is
    // the superuser, and a superuser has BYPASSRLS — under it every policy is
    // inert regardless of FORCE, so a "tenancy" assertion made through the plain
    // `db` singleton proves nothing at all. `asAppRole` binds the GUC and then
    // drops to `motir_app` for the rest of the transaction, so what answers
    // below is the POLICY and not a service-level filter.
    const [rows, counts] = await asAppRole(theirs.ownerCtx, (tx) =>
      Promise.all([
        projectRoleDefinitionRepository.findManyByProject(mine.projectId, tx),
        projectRoleDefinitionRepository.countByProject(mine.projectId, tx),
      ]),
    );
    expect(rows).toEqual([]);
    expect(counts).toBe(0);

    // The same read under MY GUC does see it — otherwise the two assertions above
    // would also pass against a policy that hides the row from everyone.
    const own = await asAppRole(mine.ownerCtx, (tx) =>
      projectRoleDefinitionRepository.findManyByProject(mine.projectId, tx),
    );
    expect(own.map((r) => r.name)).toEqual(['Contractor']);

    // And a WRITE under the foreign GUC is refused by the policy, not merely by
    // the service gate that never gets the chance to run in production either.
    await expect(
      asAppRole(theirs.ownerCtx, (tx) =>
        projectRoleDefinitionRepository.update(role.id, { name: 'Stolen' }, tx),
      ),
    ).rejects.toThrow();

    // The catalog read refuses before it counts anything — a foreign project is
    // indistinguishable from a missing one.
    await expect(
      projectRoleDefinitionService.getRoleCatalog(mine.projectId, theirs.ownerCtx),
    ).rejects.toThrow();

    // And the write path refuses too, at the service rather than by accident.
    await expect(
      projectRoleDefinitionService.update({
        projectId: mine.projectId,
        roleId: role.id,
        ctx: theirs.ownerCtx,
        name: 'Stolen',
      }),
    ).rejects.toThrow();

    // Untouched, read back under its OWN context.
    const catalog = await projectRoleDefinitionService.getRoleCatalog(
      mine.projectId,
      mine.ownerCtx,
    );
    expect(catalog.roles.find((r) => r.key === role.id)?.name).toBe('Contractor');
  });
});
