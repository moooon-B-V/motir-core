import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';

// Workspace custom roles (Story MOTIR-6168 · MOTIR-6460) — the service driven
// through its REAL routes against real Postgres: create from each base, edit,
// delete-with-reassign, the Manager-only gate, the name rule and the catalog read.
// Only `getWorkspaceContext` is mocked (the test has no cookies).

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET: rolesGET, POST: rolesPOST } =
  await import('@/app/api/workspaces/[workspaceId]/roles/route');
const { PATCH: rolePATCH, DELETE: roleDELETE } =
  await import('@/app/api/workspaces/[workspaceId]/roles/[roleId]/route');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { workspaceMembershipRepository } =
  await import('@/lib/repositories/workspaceMembershipRepository');
const { WORKSPACE_ROLE_PERMISSIONS } = await import('@/lib/permissions/builtinRoles');
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

let seq = 0;

async function user(label: string) {
  return usersService.createUser({
    email: `wrr-${label}-${seq++}@ex.com`,
    password: PASSWORD,
    name: label,
  });
}

interface Fixture {
  workspaceId: string;
  organizationId: string;
  ctx: Record<'manager' | 'member' | 'viewer' | 'custom', WorkspaceContext>;
}

async function build(): Promise<Fixture> {
  const manager = await user('manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: `WRR ${seq++}`,
    ownerUserId: manager.id,
  });
  const ctx = (id: string): WorkspaceContext => ({ userId: id, workspaceId: workspace.id });
  const member = await user('member');
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  const viewer = await user('viewer');
  await workspacesService.addMember({
    userId: viewer.id,
    workspaceId: workspace.id,
    role: 'viewer',
  });
  const custom = await user('custom');
  await workspacesService.addMember({ userId: custom.id, workspaceId: workspace.id });
  const role = await adminDb.workspaceRoleDefinition.create({
    data: { workspaceId: workspace.id, name: 'Seeded', permissions: ['project:browse'] },
  });
  await adminDb.$transaction((tx) =>
    workspaceMembershipRepository.setWorkspaceRole(
      custom.id,
      workspace.id,
      { workspaceRole: 'member', roleDefinitionId: role.id },
      tx,
    ),
  );
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    ctx: {
      manager: ctx(manager.id),
      member: ctx(member.id),
      viewer: ctx(viewer.id),
      custom: ctx(custom.id),
    },
  };
}

const params = (workspaceId: string, roleId?: string) => ({
  params: Promise.resolve(roleId ? { workspaceId, roleId } : { workspaceId }),
});

async function post(fx: Fixture, as: WorkspaceContext, body: unknown) {
  ctxRef.current = as;
  return rolesPOST(
    new Request('http://t/api/workspaces/x/roles', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params(fx.workspaceId) as never,
  );
}

async function patch(fx: Fixture, as: WorkspaceContext, roleId: string, body: unknown) {
  ctxRef.current = as;
  return rolePATCH(
    new Request('http://t/api/workspaces/x/roles/y', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params(fx.workspaceId, roleId) as never,
  );
}

async function del(fx: Fixture, as: WorkspaceContext, roleId: string, query = '') {
  ctxRef.current = as;
  return roleDELETE(
    new Request(`http://t/api/workspaces/x/roles/y${query}`, { method: 'DELETE' }),
    params(fx.workspaceId, roleId) as never,
  );
}

async function get(fx: Fixture, as: WorkspaceContext | null) {
  ctxRef.current = as;
  return rolesGET(new Request('http://t/api/workspaces/x/roles'), params(fx.workspaceId) as never);
}

const sorted = (keys: Iterable<string>) => [...keys].sort();

describe('create — from each base, with the catalog as the source of truth', () => {
  it.each(['manager', 'member', 'viewer'] as const)(
    'a Manager creates a role from the %s base; with no edits it stores that set',
    async (basedOn) => {
      const fx = await build();
      const res = await post(fx, fx.ctx.manager, { name: `From ${basedOn}`, basedOn });
      expect(res.status).toBe(201);
      const { role } = (await res.json()) as { role: { id: string; permissions: string[] } };
      const stored = await adminDb.workspaceRoleDefinition.findUniqueOrThrow({
        where: { id: role.id },
      });
      expect(sorted(stored.permissions)).toEqual(sorted(WORKSPACE_ROLE_PERMISSIONS[basedOn]));
    },
  );

  it('the edits sent are the set stored — the base minus the runs view key, plus nothing', async () => {
    const fx = await build();
    const composed = [...WORKSPACE_ROLE_PERMISSIONS.viewer]
      .filter((k) => k !== 'run:view_any')
      .concat('comment:add');
    const res = await post(fx, fx.ctx.manager, {
      name: 'Reviewer',
      basedOn: 'viewer',
      permissions: composed,
    });
    expect(res.status).toBe(201);
    const { role } = (await res.json()) as { role: { id: string } };
    const stored = await adminDb.workspaceRoleDefinition.findUniqueOrThrow({
      where: { id: role.id },
    });
    expect(sorted(stored.permissions)).toEqual(sorted(composed));
  });

  it('a key outside ROLE_GATED_PERMISSIONS is refused at write time (400), as the project service refuses it', async () => {
    const fx = await build();
    for (const bad of ['public_request:submit', 'not:a:key']) {
      const res = await post(fx, fx.ctx.manager, {
        name: `Bad ${bad}`,
        basedOn: 'viewer',
        permissions: ['project:browse', bad],
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('UNGRANTABLE_PERMISSION');
    }
    expect(
      await adminDb.workspaceRoleDefinition.count({ where: { workspaceId: fx.workspaceId } }),
    ).toBe(1);
  });

  it('refuses a bad body, a bad name and an unknown base', async () => {
    const fx = await build();
    expect((await post(fx, fx.ctx.manager, 'not json')).status).toBe(400);
    expect((await post(fx, fx.ctx.manager, 'null')).status).toBe(400);
    expect((await post(fx, fx.ctx.manager, { name: 1, basedOn: 'viewer' })).status).toBe(400);
    expect(
      (await post(fx, fx.ctx.manager, { name: 'x', basedOn: 'viewer', permissions: 'x' })).status,
    ).toBe(400);
    expect((await post(fx, fx.ctx.manager, { name: '   ', basedOn: 'viewer' })).status).toBe(400);
    expect((await post(fx, fx.ctx.manager, { name: 'x', basedOn: 'owner' })).status).toBe(400);
  });

  it('a second role with an existing name is 409; the same name in ANOTHER workspace succeeds', async () => {
    const fx = await build();
    expect((await post(fx, fx.ctx.manager, { name: 'Reviewer', basedOn: 'viewer' })).status).toBe(
      201,
    );
    const dup = await post(fx, fx.ctx.manager, { name: 'Reviewer', basedOn: 'member' });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { code: string }).code).toBe('WORKSPACE_ROLE_NAME_TAKEN');

    const other = await build();
    expect(
      (await post(other, other.ctx.manager, { name: 'Reviewer', basedOn: 'viewer' })).status,
    ).toBe(201);
  });

  it('refuses a signed-out caller (401)', async () => {
    const fx = await build();
    ctxRef.current = null;
    const res = await rolesPOST(
      new Request('http://t', { method: 'POST', body: '{}' }),
      params(fx.workspaceId) as never,
    );
    expect(res.status).toBe(401);
  });
});

describe('the Manager-only gate', () => {
  it('a Member, a Viewer and a custom-role holder each get 403 from POST, PATCH and DELETE', async () => {
    const fx = await build();
    const created = await post(fx, fx.ctx.manager, { name: 'Target', basedOn: 'viewer' });
    const { role } = (await created.json()) as { role: { id: string } };
    for (const who of ['member', 'viewer', 'custom'] as const) {
      const as = fx.ctx[who];
      expect((await post(fx, as, { name: `By ${who}`, basedOn: 'viewer' })).status, who).toBe(403);
      expect((await patch(fx, as, role.id, { name: 'Renamed' })).status, who).toBe(403);
      expect((await del(fx, as, role.id)).status, who).toBe(403);
    }
  });

  it('the org Owner who is NOT a member of the workspace gets 2xx', async () => {
    const fx = await build();
    const owner = await user('org-owner');
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: fx.organizationId, role: 'owner' },
      data: { role: 'admin' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: fx.organizationId, userId: owner.id, role: 'owner' },
    });
    const as = { userId: owner.id, workspaceId: fx.workspaceId };
    const created = await post(fx, as, { name: 'By the Owner', basedOn: 'member' });
    expect(created.status).toBe(201);
    const { role } = (await created.json()) as { role: { id: string } };
    expect((await patch(fx, as, role.id, { name: 'Renamed by the Owner' })).status).toBe(200);
    expect((await del(fx, as, role.id)).status).toBe(204);
  });

  it('someone outside the workspace entirely gets 404 — a workspace they cannot see stays missing', async () => {
    const fx = await build();
    const stranger = await user('stranger');
    const res = await get(fx, { userId: stranger.id, workspaceId: fx.workspaceId });
    expect(res.status).toBe(404);
  });
});

describe('update', () => {
  it('renames and re-permissions a role; a built-in or a foreign role is refused', async () => {
    const fx = await build();
    const created = await post(fx, fx.ctx.manager, { name: 'Draft', basedOn: 'viewer' });
    const { role } = (await created.json()) as { role: { id: string } };

    const ok = await patch(fx, fx.ctx.manager, role.id, {
      name: 'Final',
      permissions: ['project:browse', 'comment:add'],
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { role: { name: string; permissions: string[] } };
    expect(body.role.name).toBe('Final');
    expect(sorted(body.role.permissions)).toEqual(['comment:add', 'project:browse']);

    expect((await patch(fx, fx.ctx.manager, 'manager', { name: 'x' })).status).toBe(403);
    const other = await build();
    const foreign = await post(other, other.ctx.manager, { name: 'Foreign', basedOn: 'viewer' });
    const { role: foreignRole } = (await foreign.json()) as { role: { id: string } };
    expect((await patch(fx, fx.ctx.manager, foreignRole.id, { name: 'x' })).status).toBe(404);
  });

  it('refuses an empty patch, a bad body, and a rename onto a taken name', async () => {
    const fx = await build();
    const created = await post(fx, fx.ctx.manager, { name: 'One', basedOn: 'viewer' });
    const { role } = (await created.json()) as { role: { id: string } };
    expect((await patch(fx, fx.ctx.manager, role.id, {})).status).toBe(400);
    expect((await patch(fx, fx.ctx.manager, role.id, 'nope')).status).toBe(400);
    expect((await patch(fx, fx.ctx.manager, role.id, 'null')).status).toBe(400);
    expect((await patch(fx, fx.ctx.manager, role.id, { permissions: 'x' })).status).toBe(400);
    expect((await patch(fx, fx.ctx.manager, role.id, { name: 'Seeded' })).status).toBe(409);
  });
});

describe('the id routes refuse a signed-out caller', () => {
  it('PATCH and DELETE answer 401 with no session', async () => {
    const fx = await build();
    ctxRef.current = null;
    const patchRes = await rolePATCH(
      new Request('http://t', { method: 'PATCH', body: '{}' }),
      params(fx.workspaceId, 'x') as never,
    );
    const delRes = await roleDELETE(
      new Request('http://t', { method: 'DELETE' }),
      params(fx.workspaceId, 'x') as never,
    );
    expect([patchRes.status, delRes.status]).toEqual([401, 401]);
  });
});

describe('delete — with the reassignment, in one transaction', () => {
  async function heldByTwo(fx: Fixture) {
    const created = await post(fx, fx.ctx.manager, { name: 'Doomed', basedOn: 'viewer' });
    const { role } = (await created.json()) as { role: { id: string } };
    for (const who of ['member', 'viewer'] as const) {
      await adminDb.$transaction((tx) =>
        workspaceMembershipRepository.setWorkspaceRole(
          fx.ctx[who].userId,
          fx.workspaceId,
          { workspaceRole: 'member', roleDefinitionId: role.id },
          tx,
        ),
      );
    }
    return role.id;
  }

  async function heldBy(fx: Fixture, who: 'member' | 'viewer') {
    return adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: fx.ctx[who].userId, workspaceId: fx.workspaceId } },
    });
  }

  it('a role held by two, with a built-in target: both hold the target and the role is gone', async () => {
    const fx = await build();
    const roleId = await heldByTwo(fx);
    expect((await del(fx, fx.ctx.manager, roleId, '?reassignToRole=viewer')).status).toBe(204);
    for (const who of ['member', 'viewer'] as const) {
      const m = await heldBy(fx, who);
      expect([m.workspaceRole, m.roleDefinitionId]).toEqual(['viewer', null]);
    }
    expect(await adminDb.workspaceRoleDefinition.findUnique({ where: { id: roleId } })).toBeNull();
  });

  it('…and with a CUSTOM target, both point at it', async () => {
    const fx = await build();
    const roleId = await heldByTwo(fx);
    const target = await adminDb.workspaceRoleDefinition.findFirstOrThrow({
      where: { workspaceId: fx.workspaceId, name: 'Seeded' },
    });
    expect(
      (await del(fx, fx.ctx.manager, roleId, `?reassignToDefinitionId=${target.id}`)).status,
    ).toBe(204);
    for (const who of ['member', 'viewer'] as const) {
      const m = await heldBy(fx, who);
      expect([m.workspaceRole, m.roleDefinitionId]).toEqual(['member', target.id]);
    }
  });

  it('without a target it answers 409 with the count, and changes nothing', async () => {
    const fx = await build();
    const roleId = await heldByTwo(fx);
    const res = await del(fx, fx.ctx.manager, roleId);
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string; count: number }).toMatchObject({
      code: 'WORKSPACE_ROLE_IN_USE',
      count: 2,
    });
    expect(
      await adminDb.workspaceRoleDefinition.findUnique({ where: { id: roleId } }),
    ).not.toBeNull();
    expect((await heldBy(fx, 'member')).roleDefinitionId).toBe(roleId);
  });

  it('an unheld role deletes with no target; an illegal target is 400 and changes nothing', async () => {
    const fx = await build();
    const created = await post(fx, fx.ctx.manager, { name: 'Unheld', basedOn: 'viewer' });
    const { role } = (await created.json()) as { role: { id: string } };
    const held = await heldByTwo(fx);
    expect((await del(fx, fx.ctx.manager, held, `?reassignToDefinitionId=${held}`)).status).toBe(
      400,
    );
    expect((await del(fx, fx.ctx.manager, held, '?reassignToDefinitionId=nope')).status).toBe(400);
    expect((await del(fx, fx.ctx.manager, held, '?reassignToRole=owner')).status).toBe(400);
    expect((await heldBy(fx, 'member')).roleDefinitionId).toBe(held);
    expect((await del(fx, fx.ctx.manager, role.id)).status).toBe(204);
  });
});

describe('GET — the catalog, readable by every member', () => {
  it('lists the three built-ins and every custom role with its holder count, for a Viewer', async () => {
    const fx = await build();
    await post(fx, fx.ctx.manager, { name: 'Auditor', basedOn: 'viewer' });
    const res = await get(fx, fx.ctx.viewer);
    expect(res.status).toBe(200);
    const catalog = (await res.json()) as {
      roles: { key?: string; name?: string; builtIn: boolean; holderCount: number }[];
      roleGatedPermissionCount: number;
    };
    expect(catalog.roles.map((r) => r.key ?? r.name)).toEqual([
      'manager',
      'member',
      'viewer',
      'Auditor',
      'Seeded',
    ]);
    const count = (k: string) => catalog.roles.find((r) => (r.key ?? r.name) === k)?.holderCount;
    // The creator is the legacy `owner` (workspace_role NULL): folded to Manager.
    expect(count('manager')).toBe(1);
    expect(count('member')).toBe(1);
    expect(count('viewer')).toBe(1);
    expect(count('Seeded')).toBe(1);
    expect(count('Auditor')).toBe(0);
    expect(catalog.roleGatedPermissionCount).toBeGreaterThan(0);
  });

  it('refuses a signed-out caller (401)', async () => {
    const fx = await build();
    expect((await get(fx, null)).status).toBe(401);
  });
});
