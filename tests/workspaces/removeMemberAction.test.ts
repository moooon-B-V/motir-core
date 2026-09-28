import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';

// Bug MOTIR-6317 — removing a workspace member is a MANAGER's act, asserted on
// the SERVER. Before the fix `removeMemberAction` refused only "not yourself" and
// `workspacesService.removeMember` took no actor at all, so a plain member could
// remove any other member, the workspace creator (the org Owner) included.
//
// Driven through the REAL action and service against real Postgres. Only the
// session doors and Next's navigation / cache / cookies are mocked, plus a
// PASS-THROUGH wrapper on `withWorkspaceContext` that records which user each
// transaction was bound as (acceptance criterion 3's RLS half).

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});
const boundAs: string[] = [];
vi.mock('@/lib/workspaces/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces/context')>();
  return {
    ...actual,
    withWorkspaceContext: ((ctx: WorkspaceContext, fn: never) => {
      boundAs.push(ctx.userId);
      return actual.withWorkspaceContext(ctx, fn);
    }) as typeof actual.withWorkspaceContext,
  };
});
vi.mock('@/lib/auth', () => ({
  getSession: async () => (ctxRef.current ? { user: { id: ctxRef.current.userId } } : null),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ set: vi.fn(), delete: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

const { removeMemberAction, leaveWorkspaceAction } =
  await import('@/app/(authed)/settings/workspace/actions');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { workspaceMembershipRepository } =
  await import('@/lib/repositories/workspaceMembershipRepository');
const { LastManagerError, LastMemberError, OrgManagedWorkspaceRoleError } =
  await import('@/lib/workspaces/errors');
const { truncateAuthTables } = await import('../helpers/db');

beforeEach(async () => {
  ctxRef.current = null;
  boundAs.length = 0;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const user = (label: string) =>
  usersService.createUser({
    email: `rma-${label}-${seq++}@ex.com`,
    password: 'hunter2hunter2',
    name: label,
  });

/**
 * The creator is the org Owner and a workspace Manager (createWorkspace mints
 * both). Beside them: a plain workspace Manager who holds no org role, a Member,
 * a second Member and a Viewer.
 */
async function build() {
  const owner = await user('owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `RMA ${seq++}`,
    ownerUserId: owner.id,
  });
  const workspaceId = workspace.id;
  const manager = await user('manager');
  await workspacesService.addMember({ userId: manager.id, workspaceId });
  await adminDb.$transaction((tx) =>
    workspaceMembershipRepository.setWorkspaceRole(
      manager.id,
      workspaceId,
      { workspaceRole: 'manager', roleDefinitionId: null },
      tx,
    ),
  );
  const member = await user('member');
  await workspacesService.addMember({ userId: member.id, workspaceId });
  const other = await user('other');
  await workspacesService.addMember({ userId: other.id, workspaceId });
  const viewer = await user('viewer');
  await workspacesService.addMember({
    userId: viewer.id,
    workspaceId,
    workspaceRole: 'viewer',
  });
  return {
    workspaceId,
    organizationId: workspace.organizationId,
    owner,
    manager,
    member,
    other,
    viewer,
  };
}

const as = (userId: string, workspaceId: string) => {
  ctxRef.current = { userId, workspaceId };
};

const memberIds = async (workspaceId: string) =>
  (await adminDb.workspaceMembership.findMany({ where: { workspaceId }, select: { userId: true } }))
    .map((m) => m.userId)
    .sort();

describe('a non-Manager is refused, and nothing changes (criterion 1)', () => {
  it('a plain Member cannot remove another Member', async () => {
    const f = await build();
    const before = await memberIds(f.workspaceId);
    as(f.member.id, f.workspaceId);
    const result = await removeMemberAction(f.other.id);
    expect(result).toEqual({ ok: false, error: 'Only a workspace Manager can remove members.' });
    expect(await memberIds(f.workspaceId)).toEqual(before);
  });

  it('a plain Member cannot remove the workspace creator (the org Owner) — the reproduction', async () => {
    const f = await build();
    const before = await memberIds(f.workspaceId);
    as(f.member.id, f.workspaceId);
    expect((await removeMemberAction(f.owner.id)).ok).toBe(false);
    expect(await memberIds(f.workspaceId)).toEqual(before);
  });

  it('a Viewer cannot remove anyone', async () => {
    const f = await build();
    const before = await memberIds(f.workspaceId);
    as(f.viewer.id, f.workspaceId);
    expect((await removeMemberAction(f.member.id)).ok).toBe(false);
    expect(await memberIds(f.workspaceId)).toEqual(before);
  });
});

describe('a Manager still removes a member (criterion 2)', () => {
  it('the workspace creator removes a Member', async () => {
    const f = await build();
    as(f.owner.id, f.workspaceId);
    expect(await removeMemberAction(f.member.id)).toEqual({ ok: true });
    expect(await memberIds(f.workspaceId)).not.toContain(f.member.id);
  });

  it('a plain workspace Manager (no org role) removes a Member', async () => {
    const f = await build();
    as(f.manager.id, f.workspaceId);
    expect(await removeMemberAction(f.member.id)).toEqual({ ok: true });
    expect(await memberIds(f.workspaceId)).not.toContain(f.member.id);
  });

  it('removing yourself is still refused here — that is Leave', async () => {
    const f = await build();
    as(f.owner.id, f.workspaceId);
    expect(await removeMemberAction(f.owner.id)).toEqual({
      ok: false,
      error: 'Use Leave to remove yourself.',
    });
  });

  it('a Manager cannot remove the org Owner or an org Admin — their org role decides', async () => {
    const f = await build();
    const before = await memberIds(f.workspaceId);
    as(f.manager.id, f.workspaceId);
    expect((await removeMemberAction(f.owner.id)).ok).toBe(false);
    await adminDb.organizationMembership.updateMany({
      where: { organizationId: f.organizationId, userId: f.member.id },
      data: { role: 'admin' },
    });
    await expect(
      workspacesService.removeMember({
        actorUserId: f.manager.id,
        targetUserId: f.member.id,
        workspaceId: f.workspaceId,
      }),
    ).rejects.toBeInstanceOf(OrgManagedWorkspaceRoleError);
    expect(await memberIds(f.workspaceId)).toEqual(before);
  });

  it('the last-member refusal is unchanged — the org Owner, reaching by org role, cannot empty the workspace', async () => {
    const owner = await user('solo-owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: `RMA ${seq++}`,
      ownerUserId: owner.id,
    });
    const member = await user('solo-member');
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    // The Owner leaves; they still reach the workspace as a Manager by org role.
    await workspacesService.leaveWorkspace({ userId: owner.id, workspaceId: workspace.id });

    as(owner.id, workspace.id);
    expect(await removeMemberAction(member.id)).toEqual({
      ok: false,
      error: 'Cannot remove the last member.',
    });
    await expect(
      workspacesService.removeMember({
        actorUserId: owner.id,
        targetUserId: member.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(LastMemberError);
    expect(await memberIds(workspace.id)).toEqual([member.id]);
  });

  it('removing the only workspace Manager is refused — LastManagerError', async () => {
    const owner = await user('lm-owner');
    const { workspace } = await workspacesService.createWorkspace({
      name: `RMA ${seq++}`,
      ownerUserId: owner.id,
    });
    const manager = await user('lm-manager');
    await workspacesService.addMember({ userId: manager.id, workspaceId: workspace.id });
    await adminDb.$transaction((tx) =>
      workspaceMembershipRepository.setWorkspaceRole(
        manager.id,
        workspace.id,
        { workspaceRole: 'manager', roleDefinitionId: null },
        tx,
      ),
    );
    const member = await user('lm-member');
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    await workspacesService.leaveWorkspace({ userId: owner.id, workspaceId: workspace.id });

    await expect(
      workspacesService.removeMember({
        actorUserId: owner.id,
        targetUserId: manager.id,
        workspaceId: workspace.id,
      }),
    ).rejects.toBeInstanceOf(LastManagerError);
    expect(await memberIds(workspace.id)).toEqual([manager.id, member.id].sort());
  });

  it('a non-member target is an idempotent no-op', async () => {
    const f = await build();
    const stranger = await user('stranger');
    expect(
      await workspacesService.removeMember({
        actorUserId: f.owner.id,
        targetUserId: stranger.id,
        workspaceId: f.workspaceId,
      }),
    ).toBeNull();
  });
});

describe('the service takes an actor, and binds as the ACTOR (criterion 3)', () => {
  it('cannot be called without an actor', () => {
    const call = () =>
      // @ts-expect-error — `actorUserId` is required (MOTIR-6317).
      workspacesService.removeMember({ targetUserId: 'u', workspaceId: 'w' });
    expect(typeof call).toBe('function');
  });

  it('opens its RLS context as the actor, never the target', async () => {
    const f = await build();
    boundAs.length = 0;
    await workspacesService.removeMember({
      actorUserId: f.manager.id,
      targetUserId: f.member.id,
      workspaceId: f.workspaceId,
    });
    expect(boundAs.length).toBeGreaterThan(0);
    expect(boundAs).not.toContain(f.member.id);
    expect(boundAs[0]).toBe(f.manager.id);
  });
});

describe('any member may still leave (criterion 4)', () => {
  it('a plain Member leaves through leaveWorkspaceAction', async () => {
    const f = await build();
    as(f.member.id, f.workspaceId);
    await expect(leaveWorkspaceAction()).rejects.toThrow('redirect:/dashboard');
    expect(await memberIds(f.workspaceId)).not.toContain(f.member.id);
  });

  it('a Viewer leaves too', async () => {
    const f = await build();
    as(f.viewer.id, f.workspaceId);
    await expect(leaveWorkspaceAction()).rejects.toThrow('redirect:/dashboard');
    expect(await memberIds(f.workspaceId)).not.toContain(f.viewer.id);
  });
});
