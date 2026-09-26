import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';

// A Manager changes a member's WORKSPACE role (Story MOTIR-6168 · MOTIR-6463) —
// the service driven through its REAL route and its REAL server action against
// real Postgres: the Manager-only gate, the last-Manager guard (including two
// Managers demoting each other at once), a custom role, the refusals, and the
// new role taking effect in every project on the next permission read. Only the
// session doors are mocked (the test has no cookies).

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});
vi.mock('@/lib/auth', () => ({
  getSession: async () => (ctxRef.current ? { user: { id: ctxRef.current.userId } } : null),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

const { PATCH } = await import('@/app/api/workspaces/[workspaceId]/members/[userId]/route');
const { setMemberRoleAction } = await import('@/app/(authed)/settings/workspace/actions');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { projectAccessService } = await import('@/lib/services/projectAccessService');
const { workspaceMembershipRepository } =
  await import('@/lib/repositories/workspaceMembershipRepository');
const { LastManagerError, WorkspaceRoleForbiddenError } = await import('@/lib/workspaces/errors');
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
    email: `mrr-${label}-${seq++}@ex.com`,
    password: PASSWORD,
    name: label,
  });
}

type Who = 'manager' | 'member' | 'viewer' | 'custom';

interface Fixture {
  workspaceId: string;
  organizationId: string;
  ids: Record<Who, string>;
  ctx: Record<Who, WorkspaceContext>;
  customRoleId: string;
}

async function build(): Promise<Fixture> {
  const manager = await user('manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: `MRR ${seq++}`,
    ownerUserId: manager.id,
  });
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
    data: { workspaceId: workspace.id, name: 'Reviewer', permissions: ['project:browse'] },
  });
  await adminDb.$transaction((tx) =>
    workspaceMembershipRepository.setWorkspaceRole(
      custom.id,
      workspace.id,
      { workspaceRole: 'member', roleDefinitionId: role.id },
      tx,
    ),
  );
  const ids = { manager: manager.id, member: member.id, viewer: viewer.id, custom: custom.id };
  const ctx = Object.fromEntries(
    Object.entries(ids).map(([k, id]) => [k, { userId: id, workspaceId: workspace.id }]),
  ) as Record<Who, WorkspaceContext>;
  return {
    workspaceId: workspace.id,
    organizationId: workspace.organizationId,
    ids,
    ctx,
    customRoleId: role.id,
  };
}

async function patch(fx: Fixture, as: WorkspaceContext | null, target: string, body: unknown) {
  ctxRef.current = as;
  return PATCH(
    new Request('http://t/api/workspaces/x/members/y', {
      method: 'PATCH',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ workspaceId: fx.workspaceId, userId: target }) } as never,
  );
}

async function storedRole(workspaceId: string, userId: string) {
  const m = await adminDb.workspaceMembership.findUniqueOrThrow({
    where: { userId_workspaceId: { userId, workspaceId } },
  });
  return { workspaceRole: m.workspaceRole, roleDefinitionId: m.roleDefinitionId };
}

const sorted = (keys: Iterable<string>) => [...keys].sort();

describe('a Manager changes a role, and it holds in every project at once', () => {
  it('Member → Viewer: the next permission read in TWO projects is the Viewer set', async () => {
    const fx = await build();
    const projects = [];
    for (const name of ['Alpha', 'Beta']) {
      projects.push(
        await projectsService.createProject({
          workspaceId: fx.workspaceId,
          actorUserId: fx.ids.manager,
          name,
        }),
      );
    }
    const perms = (who: Who, projectId: string) =>
      projectAccessService.getPermissions(projectId, fx.ctx[who]).then(sorted);

    for (const p of projects) {
      expect(await perms('member', p.id)).not.toEqual(await perms('viewer', p.id));
    }

    const res = await patch(fx, fx.ctx.manager, fx.ids.member, { role: 'viewer' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: fx.ids.member,
      workspaceRole: 'viewer',
      customRole: null,
    });

    for (const p of projects) {
      expect(await perms('member', p.id)).toEqual(await perms('viewer', p.id));
    }
  });

  it('assigns a workspace custom role at the member tier, and back to a built-in', async () => {
    const fx = await build();
    const res = await patch(fx, fx.ctx.manager, fx.ids.member, {
      roleDefinitionId: fx.customRoleId,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: fx.ids.member,
      workspaceRole: 'member',
      customRole: { id: fx.customRoleId, name: 'Reviewer' },
    });
    expect(await storedRole(fx.workspaceId, fx.ids.member)).toEqual({
      workspaceRole: 'member',
      roleDefinitionId: fx.customRoleId,
    });

    expect((await patch(fx, fx.ctx.manager, fx.ids.custom, { role: 'manager' })).status).toBe(200);
    expect(await storedRole(fx.workspaceId, fx.ids.custom)).toEqual({
      workspaceRole: 'manager',
      roleDefinitionId: null,
    });
  });

  it('listMembers reports workspaceRole and customRole for every row', async () => {
    const fx = await build();
    const members = await workspacesService.listMembers(fx.workspaceId, fx.ids.manager);
    const byId = new Map(members.map((m) => [m.userId, m]));
    expect(members).toHaveLength(4);
    expect(byId.get(fx.ids.manager)).toMatchObject({ workspaceRole: 'manager', customRole: null });
    expect(byId.get(fx.ids.member)).toMatchObject({ workspaceRole: 'member', customRole: null });
    expect(byId.get(fx.ids.viewer)).toMatchObject({ workspaceRole: 'viewer', customRole: null });
    expect(byId.get(fx.ids.custom)).toMatchObject({
      workspaceRole: 'member',
      customRole: { id: fx.customRoleId, name: 'Reviewer' },
    });
  });
});

describe('who may change a role', () => {
  it('a Member, a Viewer and a custom-role holder each get 403, and nothing changes', async () => {
    const fx = await build();
    for (const who of ['member', 'viewer', 'custom'] as const) {
      const target = who === 'viewer' ? fx.ids.member : fx.ids.viewer;
      const before = await storedRole(fx.workspaceId, target);
      const res = await patch(fx, fx.ctx[who], target, { role: 'manager' });
      expect(res.status, who).toBe(403);
      expect(await storedRole(fx.workspaceId, target), who).toEqual(before);
    }
  });

  it('the gate runs BEFORE a custom role id is resolved — a non-Manager cannot probe role ids', async () => {
    // Moved from the retired project-role assignment test (MOTIR-2485's
    // ordering): a foreign id and a real one answer a non-Manager the same 403.
    const fx = await build();
    const other = await build();
    for (const roleDefinitionId of [fx.customRoleId, other.customRoleId, 'no-such-role']) {
      const res = await patch(fx, fx.ctx.member, fx.ids.viewer, { roleDefinitionId });
      expect(res.status, roleDefinitionId).toBe(403);
    }
  });

  it('the org Owner with no membership in the workspace gets 200', async () => {
    const fx = await build();
    const owner = await user('org-owner');
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: fx.organizationId, role: 'owner' },
      data: { role: 'member' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: fx.organizationId, userId: owner.id, role: 'owner' },
    });
    const res = await patch(fx, { userId: owner.id, workspaceId: fx.workspaceId }, fx.ids.viewer, {
      role: 'member',
    });
    expect(res.status).toBe(200);
    expect((await storedRole(fx.workspaceId, fx.ids.viewer)).workspaceRole).toBe('member');
  });

  it('someone outside the workspace gets 404; an unauthenticated call 401', async () => {
    const fx = await build();
    const stranger = await user('stranger');
    const res = await patch(
      fx,
      { userId: stranger.id, workspaceId: fx.workspaceId },
      fx.ids.member,
      { role: 'viewer' },
    );
    expect(res.status).toBe(404);
    expect((await patch(fx, null, fx.ids.member, { role: 'viewer' })).status).toBe(401);
  });

  it('an org Owner or Admin cannot be given a workspace role here — 409, their org role decides', async () => {
    const fx = await build();
    // The creator is the org Owner (createWorkspace minted the org).
    const res = await patch(fx, fx.ctx.manager, fx.ids.manager, { role: 'viewer' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('ORG_MANAGED_WORKSPACE_ROLE');
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: fx.organizationId, userId: fx.ids.member },
      data: { role: 'admin' },
    });
    expect((await patch(fx, fx.ctx.manager, fx.ids.member, { role: 'viewer' })).status).toBe(409);
  });
});

describe('the last Manager', () => {
  /** A workspace whose Managers are plain org members, so no org role shields them. */
  async function withPlainManagers(n: number) {
    const fx = await build();
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: fx.organizationId, userId: fx.ids.manager },
      data: { role: 'member' },
    });
    const orgOwner = await user('org-owner');
    await adminDb.organizationMembership.create({
      data: { organizationId: fx.organizationId, userId: orgOwner.id, role: 'owner' },
    });
    const managers = [fx.ids.manager];
    for (let i = 1; i < n; i++) {
      const m = await user(`manager-${i}`);
      await workspacesService.addMember({ userId: m.id, workspaceId: fx.workspaceId });
      await adminDb.$transaction((tx) =>
        workspaceMembershipRepository.setWorkspaceRole(
          m.id,
          fx.workspaceId,
          { workspaceRole: 'manager', roleDefinitionId: null },
          tx,
        ),
      );
      managers.push(m.id);
    }
    return { fx, managers };
  }

  it('demoting the only Manager answers 409 LastManagerError and changes nothing', async () => {
    const { fx } = await withPlainManagers(1);
    const res = await patch(fx, fx.ctx.manager, fx.ids.manager, { role: 'member' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('LAST_MANAGER');
    expect((await storedRole(fx.workspaceId, fx.ids.manager)).workspaceRole).toBe('manager');
  });

  it('two Managers demoting each other at once end with exactly one Manager', async () => {
    const { fx, managers } = await withPlainManagers(2);
    const [a, b] = managers as [string, string];
    const results = await Promise.allSettled([
      workspacesService.setMemberRole({
        actorUserId: a,
        workspaceId: fx.workspaceId,
        targetUserId: b,
        role: 'member',
      }),
      workspacesService.setMemberRole({
        actorUserId: b,
        workspaceId: fx.workspaceId,
        targetUserId: a,
        role: 'member',
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Which refusal the loser sees depends on WHEN its reads land, and both are
    // right: read before the winner commits, it passes the actor check, blocks
    // on the Manager-row lock, wakes to one Manager left and is LastManagerError;
    // read after, it is no longer a Manager at all. Either winner is accepted.
    expect(
      rejected[0]!.reason instanceof LastManagerError ||
        rejected[0]!.reason instanceof WorkspaceRoleForbiddenError,
    ).toBe(true);
    const stillManagers = await adminDb.workspaceMembership.count({
      where: { workspaceId: fx.workspaceId, workspaceRole: 'manager' },
    });
    expect(stillManagers).toBe(1);
  });

  it('a demotion that WAITS on the Manager-row lock wakes to one Manager left and is refused', async () => {
    // The deterministic half of the race above: hold the winner's transaction open
    // with the Manager rows locked and B already demoted, start B's demotion of A,
    // and release only once Postgres reports B's transaction WAITING on the lock.
    const { fx, managers } = await withPlainManagers(2);
    const [a, b] = managers as [string, string];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let signalLocked!: () => void;
    const locked = new Promise<void>((r) => (signalLocked = r));
    const winner = adminDb.$transaction(
      async (tx) => {
        await workspaceMembershipRepository.countManagers(fx.workspaceId, tx);
        await workspaceMembershipRepository.setWorkspaceRole(
          b,
          fx.workspaceId,
          { workspaceRole: 'member', roleDefinitionId: null },
          tx,
        );
        signalLocked();
        await held;
      },
      { timeout: 30_000 },
    );
    await locked;
    const loser = workspacesService.setMemberRole({
      actorUserId: b,
      workspaceId: fx.workspaceId,
      targetUserId: a,
      role: 'member',
    });
    const settled = loser.catch((err: unknown) => err);
    await expect
      .poll(
        async () =>
          (
            await adminDb.$queryRaw<Array<{ n: number }>>`
              SELECT count(*)::int AS n FROM pg_locks l
              JOIN pg_stat_activity a ON a.pid = l.pid
              WHERE NOT l.granted AND a.datname = current_database()`
          )[0]!.n,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    release();
    await winner;
    expect(await settled).toBeInstanceOf(LastManagerError);
    expect((await storedRole(fx.workspaceId, a)).workspaceRole).toBe('manager');
  });

  it('a Manager may step down while another Manager remains', async () => {
    const { fx, managers } = await withPlainManagers(2);
    const res = await patch(fx, fx.ctx.manager, fx.ids.manager, { role: 'viewer' });
    expect(res.status).toBe(200);
    expect((await storedRole(fx.workspaceId, managers[1]!)).workspaceRole).toBe('manager');
  });
});

describe('malformed requests', () => {
  it('an unknown role string answers 422; a foreign custom role 404; a non-member target 404', async () => {
    const fx = await build();
    expect((await patch(fx, fx.ctx.manager, fx.ids.member, { role: 'owner' })).status).toBe(422);
    expect((await patch(fx, fx.ctx.manager, fx.ids.member, {})).status).toBe(422);

    const other = await build();
    expect(
      (await patch(fx, fx.ctx.manager, fx.ids.member, { roleDefinitionId: other.customRoleId }))
        .status,
    ).toBe(404);

    const stranger = await user('stranger');
    expect((await patch(fx, fx.ctx.manager, stranger.id, { role: 'viewer' })).status).toBe(404);
    expect(await storedRole(fx.workspaceId, fx.ids.member)).toEqual({
      workspaceRole: 'member',
      roleDefinitionId: null,
    });
  });

  it('a body that is not JSON, not an object, or with a non-string role id is 400', async () => {
    const fx = await build();
    expect((await patch(fx, fx.ctx.manager, fx.ids.member, 'not json')).status).toBe(400);
    expect((await patch(fx, fx.ctx.manager, fx.ids.member, 'null')).status).toBe(400);
    expect((await patch(fx, fx.ctx.manager, fx.ids.member, { roleDefinitionId: 7 })).status).toBe(
      400,
    );
  });
});

describe('setMemberRoleAction — the Members page door', () => {
  function asActive(fx: Fixture, who: Who) {
    ctxRef.current = fx.ctx[who];
  }

  it('changes the role for a Manager', async () => {
    const fx = await build();
    asActive(fx, 'manager');
    expect(await setMemberRoleAction(fx.ids.member, 'viewer')).toEqual({ ok: true });
    expect((await storedRole(fx.workspaceId, fx.ids.member)).workspaceRole).toBe('viewer');
    expect(await setMemberRoleAction(fx.ids.viewer, 'member', fx.customRoleId)).toEqual({
      ok: true,
    });
    expect((await storedRole(fx.workspaceId, fx.ids.viewer)).roleDefinitionId).toBe(
      fx.customRoleId,
    );
  });

  it('turns every refusal into { ok: false, error } and writes nothing', async () => {
    const fx = await build();
    asActive(fx, 'member');
    const forbidden = await setMemberRoleAction(fx.ids.viewer, 'manager');
    expect(forbidden.ok).toBe(false);
    expect(forbidden.error).toBeTruthy();

    asActive(fx, 'manager');
    for (const result of [
      await setMemberRoleAction(fx.ids.manager, 'member'), // org Owner — org-managed
      await setMemberRoleAction('nobody', 'member'), // not a member
      await setMemberRoleAction(fx.ids.member, 'owner' as never), // not a role
    ]) {
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
    expect((await storedRole(fx.workspaceId, fx.ids.member)).workspaceRole).toBe('member');
  });

  it('reports the last-Manager refusal', async () => {
    const fx = await build();
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: fx.organizationId, userId: fx.ids.manager },
      data: { role: 'member' },
    });
    const orgOwner = await user('org-owner');
    await adminDb.organizationMembership.create({
      data: { organizationId: fx.organizationId, userId: orgOwner.id, role: 'owner' },
    });
    asActive(fx, 'manager');
    const result = await setMemberRoleAction(fx.ids.manager, 'viewer');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
