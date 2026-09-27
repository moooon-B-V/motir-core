import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';

// A Manager sets a member's ACCESS SCOPE (Story MOTIR-6169 · MOTIR-6545) — the
// service and its REAL route against real Postgres: the Manager-only gate, the
// refusal on a Manager / org-Admin target, the idempotent no-op, the scope taking
// effect in every project at once, and the Members list's two new fields. Only
// `getWorkspaceContext` is mocked (the test has no cookies).

const ctxRef = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { PATCH } =
  await import('@/app/api/workspaces/[workspaceId]/members/[userId]/access-scope/route');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { truncateAuthTables } = await import('../helpers/db');
const { AccessScopeForbiddenError, ScopeNotApplicableError, InvalidAccessScopeError } =
  await import('@/lib/workspaces/errors');

beforeEach(async () => {
  ctxRef.current = null;
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;
const user = (label: string) =>
  usersService.createUser({
    email: `mas-${label}-${seq++}@ex.com`,
    password: 'hunter2hunter2',
    name: label,
  });

async function build() {
  const manager = await user('manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: `MAS ${seq++}`,
    ownerUserId: manager.id,
  });
  const member = await user('member');
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  const other = await user('other');
  await workspacesService.addMember({ userId: other.id, workspaceId: workspace.id });
  // An org Admin who is NOT a member of the workspace — a Manager by their org role.
  const orgAdmin = await user('orgadmin');
  await adminDb.organizationMembership.create({
    data: { organizationId: workspace.organizationId, userId: orgAdmin.id, role: 'admin' },
  });
  const A = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: manager.id,
    name: 'Alpha',
  });
  const B = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: manager.id,
    name: 'Beta',
  });
  await projectMembersService.addMember({
    key: A.identifier,
    actorUserId: manager.id,
    ctx: { userId: manager.id, workspaceId: workspace.id },
    targetUserId: member.id,
  });
  return { workspaceId: workspace.id, manager, member, other, orgAdmin, A, B };
}

const scopeOf = async (userId: string, workspaceId: string) =>
  (
    await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId, workspaceId } },
    })
  ).accessScope;

describe('workspacesService.setMemberAccessScope', () => {
  it('a Manager sets Limited, and the target lists only the projects they were added to on the next call', async () => {
    const f = await build();
    expect((await projectsService.listProjects(f.workspaceId, f.member.id)).length).toBe(2);
    const res = await workspacesService.setMemberAccessScope({
      actorUserId: f.manager.id,
      workspaceId: f.workspaceId,
      targetUserId: f.member.id,
      scope: 'limited',
    });
    expect(res).toEqual({ userId: f.member.id, accessScope: 'limited' });
    expect(await scopeOf(f.member.id, f.workspaceId)).toBe('limited');
    const listed = await projectsService.listProjects(f.workspaceId, f.member.id);
    expect(listed.map((p) => p.identifier)).toEqual([f.A.identifier]);
  });

  it('a workspace Member is refused with the typed forbidden error and nothing changes', async () => {
    const f = await build();
    await expect(
      workspacesService.setMemberAccessScope({
        actorUserId: f.member.id,
        workspaceId: f.workspaceId,
        targetUserId: f.other.id,
        scope: 'limited',
      }),
    ).rejects.toBeInstanceOf(AccessScopeForbiddenError);
    expect(await scopeOf(f.other.id, f.workspaceId)).toBe('full');
  });

  it('Limited on a Manager target, and on an org Admin who is not a member, is refused and changes nothing', async () => {
    const f = await build();
    for (const target of [f.manager.id, f.orgAdmin.id]) {
      await expect(
        workspacesService.setMemberAccessScope({
          actorUserId: f.manager.id,
          workspaceId: f.workspaceId,
          targetUserId: target,
          scope: 'limited',
        }),
      ).rejects.toBeInstanceOf(ScopeNotApplicableError);
    }
    expect(await scopeOf(f.manager.id, f.workspaceId)).toBe('full');
    // …and Full on a Manager is the truth already — an idempotent no-op.
    await expect(
      workspacesService.setMemberAccessScope({
        actorUserId: f.manager.id,
        workspaceId: f.workspaceId,
        targetUserId: f.orgAdmin.id,
        scope: 'full',
      }),
    ).resolves.toEqual({ userId: f.orgAdmin.id, accessScope: 'full' });
  });

  it('full → full writes nothing', async () => {
    const f = await build();
    const before = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: f.member.id, workspaceId: f.workspaceId } },
    });
    await workspacesService.setMemberAccessScope({
      actorUserId: f.manager.id,
      workspaceId: f.workspaceId,
      targetUserId: f.member.id,
      scope: 'full',
    });
    const after = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: f.member.id, workspaceId: f.workspaceId } },
    });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('rejects an unknown scope before any read', async () => {
    const f = await build();
    await expect(
      workspacesService.setMemberAccessScope({
        actorUserId: f.manager.id,
        workspaceId: f.workspaceId,
        targetUserId: f.member.id,
        scope: 'partial',
      }),
    ).rejects.toBeInstanceOf(InvalidAccessScopeError);
  });
});

describe('workspacesService.listMembers — accessScope and addedProjectCount', () => {
  it('carries both fields for every row', async () => {
    const f = await build();
    await workspacesService.setMemberAccessScope({
      actorUserId: f.manager.id,
      workspaceId: f.workspaceId,
      targetUserId: f.member.id,
      scope: 'limited',
    });
    const rows = await workspacesService.listMembers(f.workspaceId, f.manager.id);
    const byId = new Map(rows.map((r) => [r.userId, r]));
    expect(byId.get(f.member.id)).toMatchObject({ accessScope: 'limited', addedProjectCount: 1 });
    expect(byId.get(f.other.id)).toMatchObject({ accessScope: 'full', addedProjectCount: 0 });
    for (const row of rows) {
      expect(['full', 'limited']).toContain(row.accessScope);
      expect(typeof row.addedProjectCount).toBe('number');
    }
  });
});

describe('PATCH /api/workspaces/:workspaceId/members/:userId/access-scope', () => {
  const call = (workspaceId: string, userId: string, body: unknown) =>
    PATCH(
      new Request(`http://localhost/api/workspaces/${workspaceId}/members/${userId}/access-scope`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ workspaceId, userId }) },
    );

  it('200 with the member scope, 403 for a non-Manager, 400 for an unknown scope, 409 on a Manager target', async () => {
    const f = await build();
    ctxRef.current = { userId: f.manager.id, workspaceId: f.workspaceId };
    const ok = await call(f.workspaceId, f.member.id, { accessScope: 'limited' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ userId: f.member.id, accessScope: 'limited' });
    expect((await call(f.workspaceId, f.member.id, { accessScope: 'x' })).status).toBe(400);
    expect((await call(f.workspaceId, f.manager.id, { accessScope: 'limited' })).status).toBe(409);
    ctxRef.current = { userId: f.other.id, workspaceId: f.workspaceId };
    expect((await call(f.workspaceId, f.member.id, { accessScope: 'full' })).status).toBe(403);
  });

  it('401 with no session, and 400 for a body that is not JSON or names no scope — before any write', async () => {
    const f = await build();
    const unauth = await call(f.workspaceId, f.member.id, { accessScope: 'limited' });
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toMatchObject({ code: 'UNAUTHENTICATED' });

    ctxRef.current = { userId: f.manager.id, workspaceId: f.workspaceId };
    const notJson = await PATCH(
      new Request(
        `http://localhost/api/workspaces/${f.workspaceId}/members/${f.member.id}/access-scope`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: '{not json',
        },
      ),
      { params: Promise.resolve({ workspaceId: f.workspaceId, userId: f.member.id }) },
    );
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ code: 'BAD_REQUEST' });
    expect((await call(f.workspaceId, f.member.id, { scope: 'limited' })).status).toBe(400);
    expect((await call(f.workspaceId, f.member.id, null)).status).toBe(400);

    const rows = await workspacesService.listMembers(f.workspaceId, f.manager.id);
    expect(rows.find((r) => r.userId === f.member.id)?.accessScope).toBe('full');
  });

  it('rethrows an error it has no status for, rather than answering it', async () => {
    const f = await build();
    ctxRef.current = { userId: f.manager.id, workspaceId: f.workspaceId };
    const spy = vi
      .spyOn(workspacesService, 'setMemberAccessScope')
      .mockRejectedValueOnce(new Error('the database went away'));
    await expect(call(f.workspaceId, f.member.id, { accessScope: 'limited' })).rejects.toThrow(
      'the database went away',
    );
    spy.mockRestore();
  });
});

describe('workspacesService.setMemberAccessScope — who is refused before anything is written', () => {
  it('a reader who is not in the workspace is NOT_A_MEMBER', async () => {
    const f = await build();
    const stranger = await user('stranger2');
    await expect(
      workspacesService.setMemberAccessScope({
        actorUserId: stranger.id,
        workspaceId: f.workspaceId,
        targetUserId: f.member.id,
        scope: 'limited',
      }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });

  it('a target who is not a member of the workspace is not found', async () => {
    const f = await build();
    const outsider = await user('outsider');
    await expect(
      workspacesService.setMemberAccessScope({
        actorUserId: f.manager.id,
        workspaceId: f.workspaceId,
        targetUserId: outsider.id,
        scope: 'limited',
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/NOT_FOUND|NOT_A_MEMBER/) });
  });
});

describe('workspacesService.getMemberRoleContext — who may invite, and with which projects (MOTIR-6551)', () => {
  it('a Manager may invite with Limited, and is handed every project for the picker', async () => {
    const f = await build();
    const c = await workspacesService.getMemberRoleContext(f.workspaceId, f.manager.id);
    expect(c.canInvite).toBe(true);
    expect(c.inviteProjects.map((p) => p.identifier).sort()).toEqual(
      [f.A.identifier, f.B.identifier].sort(),
    );
  });

  it('a Full Member may invite (Full only) and is handed no projects; a Limited one may not invite', async () => {
    const f = await build();
    const full = await workspacesService.getMemberRoleContext(f.workspaceId, f.member.id);
    expect(full).toMatchObject({ canManageRoles: false, canInvite: true, inviteProjects: [] });
    await workspacesService.setMemberAccessScope({
      actorUserId: f.manager.id,
      workspaceId: f.workspaceId,
      targetUserId: f.member.id,
      scope: 'limited',
    });
    const limited = await workspacesService.getMemberRoleContext(f.workspaceId, f.member.id);
    expect(limited.canInvite).toBe(false);
  });

  it('an org Admin who never joined is a Manager here, and may invite', async () => {
    const f = await build();
    const c = await workspacesService.getMemberRoleContext(f.workspaceId, f.orgAdmin.id);
    expect(c).toMatchObject({ canManageRoles: true, canInvite: true });
  });
});

describe('workspacesService.listMemberAddedProjects — the "N projects" popover (MOTIR-6551)', () => {
  it('names the projects the person was added to', async () => {
    const f = await build();
    const projects = await workspacesService.listMemberAddedProjects(
      f.workspaceId,
      f.manager.id,
      f.member.id,
    );
    expect(projects).toEqual([{ id: f.A.id, name: 'Alpha', identifier: f.A.identifier }]);
  });

  it('never names a project the VIEWER cannot enter', async () => {
    const f = await build();
    // Alpha goes Members only; `other` was never added to it, so they may not
    // learn its name from someone else's row.
    await projectMembersService.setAccessMode({
      key: f.A.identifier,
      mode: 'members',
      actorUserId: f.manager.id,
      ctx: { userId: f.manager.id, workspaceId: f.workspaceId },
    });
    expect(
      await workspacesService.listMemberAddedProjects(f.workspaceId, f.other.id, f.member.id),
    ).toEqual([]);
    // The Manager still sees it.
    expect(
      (await workspacesService.listMemberAddedProjects(f.workspaceId, f.manager.id, f.member.id))
        .length,
    ).toBe(1);
  });

  it('refuses a reader who is not in the workspace', async () => {
    const f = await build();
    const stranger = await user('stranger');
    await expect(
      workspacesService.listMemberAddedProjects(f.workspaceId, stranger.id, f.member.id),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });
});
