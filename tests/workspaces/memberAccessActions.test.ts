import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';

// The Members page's two new Server Actions (Story MOTIR-6169 · MOTIR-6551),
// through the REAL action and service against real Postgres:
//
//   * `listMemberAddedProjectsAction` — the "N projects" popover's read, narrowed
//     to what the VIEWER can enter;
//   * `openProjectAccessAction` — the door to one project's Access & members page,
//     which sets the actor's active project through `setActiveProject`'s entry
//     gate and lands there, and leaves the actor where they are for a key they
//     cannot resolve.
//
// Only the session doors and Next's navigation / cache are mocked.

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

const { listMemberAddedProjectsAction, openProjectAccessAction, setMemberAccessScopeAction } =
  await import('@/app/(authed)/settings/workspace/actions');
const { usersService } = await import('@/lib/services/usersService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { projectMembersService } = await import('@/lib/services/projectMembersService');
const { truncateAuthTables } = await import('../helpers/db');

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
    email: `maa-${label}-${seq++}@ex.com`,
    password: 'hunter2hunter2',
    name: label,
  });

async function build() {
  const manager = await user('manager');
  const { workspace } = await workspacesService.createWorkspace({
    name: `MAA ${seq++}`,
    ownerUserId: manager.id,
  });
  const managerCtx = { userId: manager.id, workspaceId: workspace.id };
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
  const member = await user('member');
  await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
  await projectMembersService.addMember({
    key: A.identifier,
    actorUserId: manager.id,
    ctx: managerCtx,
    targetUserId: member.id,
  });
  return { workspaceId: workspace.id, manager, managerCtx, member, A, B };
}

const activeOf = async (userId: string, workspaceId: string) =>
  (
    await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId, workspaceId } },
    })
  ).activeProjectId;

describe('listMemberAddedProjectsAction', () => {
  it('answers the projects the person was added to', async () => {
    const f = await build();
    ctxRef.current = f.managerCtx;
    expect(await listMemberAddedProjectsAction(f.member.id)).toEqual({
      ok: true,
      projects: [{ id: f.A.id, name: 'Alpha', identifier: f.A.identifier }],
    });
  });

  it('refuses, with a message, a reader who is not in the workspace', async () => {
    const f = await build();
    const stranger = await user('stranger');
    ctxRef.current = { userId: stranger.id, workspaceId: f.workspaceId };
    const result = await listMemberAddedProjectsAction(f.member.id);
    expect(result.ok).toBe(false);
  });
});

describe('openProjectAccessAction', () => {
  it('makes the project active and lands on its Access & members page', async () => {
    const f = await build();
    ctxRef.current = f.managerCtx;
    await expect(openProjectAccessAction(f.B.identifier)).rejects.toThrow(
      'redirect:/settings/project/members',
    );
    expect(await activeOf(f.manager.id, f.workspaceId)).toBe(f.B.id);
  });

  it('leaves the actor where they are for a project they cannot enter', async () => {
    const f = await build();
    await projectMembersService.setAccessMode({
      key: f.B.identifier,
      mode: 'members',
      actorUserId: f.manager.id,
      ctx: f.managerCtx,
    });
    const before = await activeOf(f.member.id, f.workspaceId);
    ctxRef.current = { userId: f.member.id, workspaceId: f.workspaceId };
    await expect(openProjectAccessAction(f.B.identifier)).resolves.toBeUndefined();
    expect(await activeOf(f.member.id, f.workspaceId)).toBe(before);
  });

  it('…and for a key that does not exist', async () => {
    const f = await build();
    ctxRef.current = f.managerCtx;
    await expect(openProjectAccessAction('NOPE')).resolves.toBeUndefined();
  });
});

describe('setMemberAccessScopeAction (MOTIR-6545) — the action the Access cell calls', () => {
  it('a Manager sets Limited, and the row reads it back', async () => {
    const f = await build();
    ctxRef.current = f.managerCtx;
    expect(await setMemberAccessScopeAction(f.member.id, 'limited')).toEqual({ ok: true });
    const row = await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: f.member.id, workspaceId: f.workspaceId } },
    });
    expect(row.accessScope).toBe('limited');
  });

  it('answers each refusal with its code and changes nothing', async () => {
    const f = await build();
    ctxRef.current = { userId: f.member.id, workspaceId: f.workspaceId };
    expect(await setMemberAccessScopeAction(f.manager.id, 'limited')).toMatchObject({
      ok: false,
      code: 'ACCESS_SCOPE_FORBIDDEN',
    });
    ctxRef.current = f.managerCtx;
    expect(await setMemberAccessScopeAction(f.manager.id, 'limited')).toMatchObject({
      ok: false,
      code: 'SCOPE_NOT_APPLICABLE',
    });
    expect(
      await setMemberAccessScopeAction(f.member.id, 'sideways' as unknown as 'full'),
    ).toMatchObject({ ok: false, code: 'INVALID_ACCESS_SCOPE' });
    const outsider = await user('outsider');
    const unknown = await setMemberAccessScopeAction(outsider.id, 'limited');
    expect(unknown.ok).toBe(false);
  });
});
