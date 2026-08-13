import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';

// Transport tests for the role-definition API (Story MOTIR-2257 · Subtask
// MOTIR-2474). The routes are thin one-service-call transports, so what these
// prove is the ROUTE layer's own concerns:
//
//   * every row of the refusal→status map, driven through the REAL service
//     against a REAL database and read off the RESPONSE — the status and the
//     wire code, never the thrown error. A test that catches the error proves
//     the service; only reading the response proves the map;
//   * the 404-BEFORE-403 ordering, so a settings surface can never be used to
//     confirm that a foreign project exists;
//   * that `RoleInUseError`'s COUNT survives the HTTP boundary, because the
//     delete dialog reads it to say how many people are affected;
//   * that a malformed body is a 400 BEFORE the service is called.
//
// `getWorkspaceContext` is the one thing stubbed (the test environment has no
// cookies) — the same single-seam exception the repo's own convention allows for
// `getSession`. Everything below it is the real path.

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { POST: rolesPOST } = await import('@/app/api/projects/[key]/roles/route');
const { PATCH: rolePATCH, DELETE: roleDELETE } =
  await import('@/app/api/projects/[key]/roles/[roleId]/route');
const { projectsService } = await import('@/lib/services/projectsService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { projectRoleDefinitionService } =
  await import('@/lib/services/projectRoleDefinitionService');
const { projectMembershipRepository } =
  await import('@/lib/repositories/projectMembershipRepository');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { MAX_CUSTOM_ROLES_PER_PROJECT } = await import('@/lib/permissions/limits');
const { truncateAuthTables } = await import('../helpers/db');

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  ctxRef.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  adminCtx: WorkspaceContext;
  memberCtx: WorkspaceContext;
  memberUserId: string;
}

async function build(slug: string, projectName?: string): Promise<Fixture> {
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
    // ⚠️ The identifier is DERIVED from the name, so two fixtures called
    // `Project <slug>` both become `PROJE` — see the cross-workspace test below,
    // which needs the two keys to genuinely differ to say anything.
    name: projectName ?? `Project ${slug}`,
  });
  const adminCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };

  const member = await usersService.createUser({
    email: `member-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Member',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  await projectMembersService.addMember({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: adminCtx,
    targetUserId: member.id,
    role: 'member',
  });

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    adminCtx,
    memberCtx: { userId: member.id, workspaceId: workspace.id },
    memberUserId: member.id,
  };
}

function post(key: string, body: unknown): Promise<Response> {
  return rolesPOST(
    new Request('http://t/api/projects/x/roles', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ key }) },
  );
}

function patch(key: string, roleId: string, body: unknown): Promise<Response> {
  return rolePATCH(
    new Request('http://t/api/projects/x/roles/y', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ key, roleId }) },
  );
}

function del(key: string, roleId: string, reassignTo?: string): Promise<Response> {
  const url = reassignTo
    ? `http://t/api/projects/x/roles/y?reassignTo=${encodeURIComponent(reassignTo)}`
    : 'http://t/api/projects/x/roles/y';
  return roleDELETE(new Request(url, { method: 'DELETE' }), {
    params: Promise.resolve({ key, roleId }),
  });
}

/** Create a role through the service, so a route test never depends on POST. */
async function seedRole(fx: Fixture, name: string, permissions: string[] = ['project:browse']) {
  return projectRoleDefinitionService.create({
    projectId: fx.projectId,
    ctx: fx.adminCtx,
    name,
    permissions,
  });
}

describe('POST /api/projects/[key]/roles', () => {
  it('201s with the service`s mapper output VERBATIM — the route defines no shape of its own', async () => {
    const fx = await build('post-ok');
    ctxRef.current = fx.adminCtx;
    const res = await post(fx.projectKey, {
      name: 'Contractor',
      permissions: ['comment:add', 'project:browse'],
    });
    expect(res.status).toBe(201);
    const { role } = (await res.json()) as { role: Record<string, unknown> };

    const fromService = await projectRoleDefinitionService.findById(
      fx.projectId,
      role['id'] as string,
      fx.adminCtx,
    );
    expect(role).toEqual(fromService);
    // …including catalog order, which the service decided and the route did not
    // re-derive.
    expect(role['permissions']).toEqual(['project:browse', 'comment:add']);
  });

  it('401s when there is no session', async () => {
    const fx = await build('post-401');
    ctxRef.current = null;
    const res = await post(fx.projectKey, { name: 'X', permissions: [] });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('UNAUTHENTICATED');
  });

  it('400s a malformed body BEFORE the service is called — and writes nothing', async () => {
    const fx = await build('post-400');
    ctxRef.current = fx.adminCtx;
    const cases: unknown[] = [
      'not json at all',
      { permissions: [] }, // missing name
      { name: 'X', permissions: 'project:browse' }, // not an array
      { name: 7, permissions: [] }, // wrong type
    ];
    for (const body of cases) {
      const res = await post(fx.projectKey, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe('BAD_REQUEST');
    }
    const projectRoleDefinitionCount = await adminDb.projectRoleDefinition.count({
      where: { projectId: fx.projectId },
    });
    expect(projectRoleDefinitionCount).toBe(0);
  });

  it('400s an ungrantable permission — the SERVICE`s refusal, mapped', async () => {
    const fx = await build('post-ungrantable');
    ctxRef.current = fx.adminCtx;
    const res = await post(fx.projectKey, {
      name: 'Bad',
      permissions: ['public_request:submit'],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('UNGRANTABLE_PERMISSION');
  });

  it('IGNORES an extraneous `basedOn` — an old client cannot resurrect the column', async () => {
    // Yue, 2026-08-09: nothing records which built-in seeded the grid. A body
    // that still sends one is accepted and the field is dropped, rather than
    // 400'd (it is not a shape error) or stored.
    const fx = await build('post-extraneous-base');
    ctxRef.current = fx.adminCtx;
    const res = await post(fx.projectKey, {
      name: 'Contractor',
      basedOn: 'admin',
      permissions: ['project:browse'],
    });
    expect(res.status).toBe(201);
    const { role } = (await res.json()) as { role: Record<string, unknown> };
    expect('basedOn' in role).toBe(false);
    const stored = await adminDb.projectRoleDefinition.findUniqueOrThrow({
      where: { id: role['id'] as string },
    });
    expect('basedOn' in stored).toBe(false);
  });

  it('403s a non-admin, naming the permission that was missing', async () => {
    const fx = await build('post-403');
    ctxRef.current = fx.memberCtx;
    const res = await post(fx.projectKey, { name: 'X', permissions: [] });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; permission: string };
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(body.permission).toBe('project:manage_access');
  });

  it('409s a duplicate name — never a raw P2002', async () => {
    const fx = await build('post-409-name');
    ctxRef.current = fx.adminCtx;
    await seedRole(fx, 'Contractor');
    const res = await post(fx.projectKey, {
      name: 'Contractor',
      permissions: [],
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('ROLE_NAME_TAKEN');
    expect(JSON.stringify(body)).not.toContain('P2002');
  });

  it('409s at the cap, carrying the limit so the page can say what it is', async () => {
    const fx = await build('post-409-cap');
    ctxRef.current = fx.adminCtx;
    for (let i = 0; i < MAX_CUSTOM_ROLES_PER_PROJECT; i += 1) await seedRole(fx, `Role ${i}`);
    const res = await post(fx.projectKey, { name: 'Extra', permissions: [] });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; limit: number };
    expect(body.code).toBe('ROLE_LIMIT_REACHED');
    expect(body.limit).toBe(MAX_CUSTOM_ROLES_PER_PROJECT);
  });
});

describe('the 404-BEFORE-403 ordering — a settings surface cannot confirm a foreign project exists', () => {
  it('a key that exists ONLY in another workspace is 404, NOT 403', async () => {
    const mine = await build('order-mine', 'Alpha project');
    const theirs = await build('order-theirs', 'Bravo project');
    expect(mine.projectKey).not.toBe(theirs.projectKey);

    ctxRef.current = mine.adminCtx;
    const res = await post(theirs.projectKey, {
      name: 'X',
      permissions: [],
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PROJECT_NOT_FOUND');
    // Nothing reached the foreign project.
    expect(
      await adminDb.projectRoleDefinition.count({ where: { projectId: theirs.projectId } }),
    ).toBe(0);
  });

  it('a key that COLLIDES across workspaces resolves to the actor`s OWN project, never the foreign one', async () => {
    // The stronger property, and the reason the test above has to force distinct
    // names to mean anything: a `[key]` is resolved WITHIN the actor's workspace
    // (`resolveProjectByKeyWithAliasInTx` takes `ctx.workspaceId`), so a foreign
    // project is not addressable by key AT ALL. Two projects named the same in
    // two workspaces share an identifier, and each actor reaches only their own.
    const mine = await build('collide-mine', 'Shared name');
    const theirs = await build('collide-theirs', 'Shared name');
    expect(mine.projectKey).toBe(theirs.projectKey);

    ctxRef.current = mine.adminCtx;
    const res = await post(theirs.projectKey, {
      name: 'Contractor',
      permissions: [],
    });
    expect(res.status).toBe(201);
    // It landed on MINE…
    const projectRoleDefinitionCount = await adminDb.projectRoleDefinition.count({
      where: { projectId: mine.projectId },
    });
    expect(projectRoleDefinitionCount).toBe(1);
    // …and never touched theirs.
    expect(
      await adminDb.projectRoleDefinition.count({ where: { projectId: theirs.projectId } }),
    ).toBe(0);
  });

  it('an actor who cannot BROWSE the project gets 404 rather than 403', async () => {
    // A `private` project the actor holds no membership in: `assertPermission`
    // fails `canBrowse` first and raises ProjectNotFoundError.
    const fx = await build('order-private');
    await projectMembersService.setAccessLevel({
      key: fx.projectKey,
      actorUserId: fx.adminCtx.userId,
      ctx: fx.adminCtx,
      level: 'private',
    });
    const outsider = await usersService.createUser({
      email: 'outsider-order@ex.com',
      password: PASSWORD,
      name: 'Outsider',
    });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });
    ctxRef.current = { userId: outsider.id, workspaceId: fx.workspaceId };

    const res = await post(fx.projectKey, { name: 'X', permissions: [] });
    expect(res.status).toBe(404);
  });

  it('a project key that never existed is 404', async () => {
    const fx = await build('order-nokey');
    ctxRef.current = fx.adminCtx;
    const res = await post('NOSUCH', { name: 'X', permissions: [] });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/projects/[key]/roles/[roleId]', () => {
  it('renames and re-permissions in ONE round trip', async () => {
    const fx = await build('patch-ok');
    ctxRef.current = fx.adminCtx;
    const role = await seedRole(fx, 'Contractor');
    const res = await patch(fx.projectKey, role.id, {
      name: 'External',
      permissions: ['project:browse', 'comment:add'],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: { name: string; permissions: string[] } };
    expect(body.role.name).toBe('External');
    expect(body.role.permissions).toEqual(['project:browse', 'comment:add']);
  });

  it('400s an empty patch and a wrongly-typed field', async () => {
    const fx = await build('patch-400');
    ctxRef.current = fx.adminCtx;
    const role = await seedRole(fx, 'Contractor');
    for (const body of [{}, { name: 7 }, { permissions: 'nope' }]) {
      const res = await patch(fx.projectKey, role.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).code).toBe('BAD_REQUEST');
    }
  });

  it('403s a BUILT-IN — the resource exists and may never be written', async () => {
    const fx = await build('patch-builtin');
    ctxRef.current = fx.adminCtx;
    for (const builtIn of ['admin', 'member', 'viewer']) {
      const res = await patch(fx.projectKey, builtIn, { name: 'Hijacked' });
      expect(res.status, builtIn).toBe(403);
      const body = (await res.json()) as { code: string; role: string };
      expect(body.code).toBe('BUILT_IN_ROLE_IMMUTABLE');
      expect(body.role).toBe(builtIn);
    }
  });

  it('404s a role belonging to another project', async () => {
    const mine = await build('patch-404-mine');
    const theirs = await build('patch-404-theirs');
    const foreign = await seedRole(theirs, 'Theirs');
    ctxRef.current = mine.adminCtx;
    const res = await patch(mine.projectKey, foreign.id, { name: 'Stolen' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('ROLE_DEFINITION_NOT_FOUND');
  });
});

describe('DELETE /api/projects/[key]/roles/[roleId]', () => {
  async function hold(fx: Fixture, userId: string, roleId: string) {
    await adminDb.$transaction((tx) =>
      projectMembershipRepository.setRoleDefinition(
        userId,
        fx.projectId,
        { roleDefinitionId: roleId, role: 'viewer' },
        tx,
      ),
    );
  }

  it('204s a role nobody holds', async () => {
    const fx = await build('del-204');
    ctxRef.current = fx.adminCtx;
    const role = await seedRole(fx, 'Unheld');
    const res = await del(fx.projectKey, role.id);
    expect(res.status).toBe(204);
    const projectRoleDefinitionRow = await adminDb.projectRoleDefinition.findUnique({
      where: { id: role.id },
    });
    expect(projectRoleDefinitionRow).toBeNull();
  });

  it('409s WITH `count: 2` when two people hold it, and the same call with a destination succeeds', async () => {
    // The card's headline row: the count has to survive the HTTP boundary,
    // because the dialog names it before it asks where the members go.
    const fx = await build('del-409-count');
    ctxRef.current = fx.adminCtx;
    const role = await seedRole(fx, 'Contractor');
    const second = await usersService.createUser({
      email: 'second-del@ex.com',
      password: PASSWORD,
      name: 'Second',
    });
    await workspacesService.addMember({ userId: second.id, workspaceId: fx.workspaceId });
    await projectMembersService.addMember({
      key: fx.projectKey,
      actorUserId: fx.adminCtx.userId,
      ctx: fx.adminCtx,
      targetUserId: second.id,
      role: 'viewer',
    });
    await hold(fx, fx.memberUserId, role.id);
    await hold(fx, second.id, role.id);

    const refused = await del(fx.projectKey, role.id);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { code: string; count: number; roleName: string };
    expect(body.code).toBe('ROLE_IN_USE');
    expect(body.count).toBe(2);
    expect(body.roleName).toBe('Contractor');
    // Nothing written by the refusal.
    const projectRoleDefinitionRow = await adminDb.projectRoleDefinition.findUnique({
      where: { id: role.id },
    });
    expect(projectRoleDefinitionRow).not.toBeNull();

    const destination = await seedRole(fx, 'Reporter');
    const ok = await del(fx.projectKey, role.id, destination.id);
    expect(ok.status).toBe(204);
    // Read the outcome BACK through the API's own view of the project, not a
    // raw row: both memberships have moved.
    const catalog = await (
      await import('@/lib/services/projectAccessService')
    ).projectAccessService.getRoleCatalog(fx.projectId, fx.adminCtx);
    expect(catalog.roles.find((r) => r.key === destination.id)?.memberCount).toBe(2);
    expect(catalog.roles.some((r) => r.key === role.id)).toBe(false);
  });

  it('400s an illegal `reassignTo`', async () => {
    const mine = await build('del-400-mine');
    const theirs = await build('del-400-theirs');
    const role = await seedRole(mine, 'Contractor');
    const foreign = await seedRole(theirs, 'Foreign');
    await hold(mine, mine.memberUserId, role.id);
    ctxRef.current = mine.adminCtx;

    for (const target of [role.id, foreign.id, 'no-such-role']) {
      const res = await del(mine.projectKey, role.id, target);
      expect(res.status, target).toBe(400);
      expect((await res.json()).code).toBe('INVALID_ROLE_REASSIGN_TARGET');
    }
    const projectRoleDefinitionRow = await adminDb.projectRoleDefinition.findUnique({
      where: { id: role.id },
    });
    expect(projectRoleDefinitionRow).not.toBeNull();
  });

  it('403s a BUILT-IN and a non-admin', async () => {
    const fx = await build('del-403');
    const role = await seedRole(fx, 'Contractor');

    ctxRef.current = fx.adminCtx;
    const builtIn = await del(fx.projectKey, 'admin');
    expect(builtIn.status).toBe(403);
    expect((await builtIn.json()).code).toBe('BUILT_IN_ROLE_IMMUTABLE');

    ctxRef.current = fx.memberCtx;
    const nonAdmin = await del(fx.projectKey, role.id);
    expect(nonAdmin.status).toBe(403);
    expect((await nonAdmin.json()).code).toBe('PERMISSION_DENIED');
    const projectRoleDefinitionRow = await adminDb.projectRoleDefinition.findUnique({
      where: { id: role.id },
    });
    expect(projectRoleDefinitionRow).not.toBeNull();
  });

  it('401s when there is no session', async () => {
    const fx = await build('del-401');
    const role = await seedRole(fx, 'Contractor');
    ctxRef.current = null;
    expect((await del(fx.projectKey, role.id)).status).toBe(401);
  });
});

describe('the map`s edges, and what it deliberately does NOT swallow', () => {
  it('a JSON body that is not an object is a 400 on both writing routes', async () => {
    const fx = await build('edge-nonobject');
    ctxRef.current = fx.adminCtx;
    const role = await seedRole(fx, 'Contractor');
    for (const body of ['null', '42', '"a string"', '[]']) {
      const created = await post(fx.projectKey, body);
      expect(created.status, `POST ${body}`).toBe(400);
      const patched = await patch(fx.projectKey, role.id, body);
      expect(patched.status, `PATCH ${body}`).toBe(400);
    }
  });

  it('PATCH 401s with no session, and 400s an unparseable body', async () => {
    const fx = await build('edge-patch-401');
    const role = await seedRole(fx, 'Contractor');
    ctxRef.current = null;
    expect((await patch(fx.projectKey, role.id, { name: 'X' })).status).toBe(401);
    ctxRef.current = fx.adminCtx;
    const bad = await patch(fx.projectKey, role.id, 'definitely not json');
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe('BAD_REQUEST');
  });

  it('an UNRECOGNISED error is RETHROWN, never dressed up as a 4xx', async () => {
    // The map returns null for anything it does not know, and the route
    // rethrows — so a genuine bug surfaces as a 500 rather than being reported
    // to the user as their mistake.
    const fx = await build('edge-rethrow');
    ctxRef.current = fx.adminCtx;
    const role = await seedRole(fx, 'Contractor');
    const boom = new Error('something genuinely unexpected');

    vi.spyOn(projectRoleDefinitionService, 'create').mockRejectedValueOnce(boom);
    await expect(post(fx.projectKey, { name: 'X', permissions: [] })).rejects.toBe(boom);

    vi.spyOn(projectRoleDefinitionService, 'update').mockRejectedValueOnce(boom);
    await expect(patch(fx.projectKey, role.id, { name: 'X' })).rejects.toBe(boom);

    vi.spyOn(projectRoleDefinitionService, 'delete').mockRejectedValueOnce(boom);
    await expect(del(fx.projectKey, role.id)).rejects.toBe(boom);
    vi.restoreAllMocks();
  });

  it('maps the legacy admin-gate refusals too, and returns null for an unknown error', async () => {
    // `NotProjectAdminError` still reaches this map through
    // `assertPermission`'s `project:administer` compatibility branch, and a
    // browse denial is a 404 — both arms asserted directly, since the routes
    // above only ever raise `PermissionDeniedError`.
    const { roleDefinitionErrorResponse } = await import('@/lib/permissions/errorResponse');
    const { NotProjectAdminError, ProjectAccessDeniedError } =
      await import('@/lib/projects/errors');
    expect(roleDefinitionErrorResponse(new NotProjectAdminError('p1'))?.status).toBe(403);
    expect(roleDefinitionErrorResponse(new ProjectAccessDeniedError('p1', 'edit'))?.status).toBe(
      403,
    );
    expect(roleDefinitionErrorResponse(new ProjectAccessDeniedError('p1', 'browse'))?.status).toBe(
      404,
    );
    expect(roleDefinitionErrorResponse(new Error('who knows'))).toBeNull();
  });
});
