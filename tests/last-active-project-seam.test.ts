import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { organizationsService } from '@/lib/services/organizationsService';
import { withUserContext, type WorkspaceContext } from '@/lib/workspaces/context';
import { WORKSPACE_COOKIE_NAME } from '@/lib/workspaces/middleware';
import { ORGANIZATION_COOKIE_NAME } from '@/lib/organizations/cookie';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// Subtask 8.8.29 — the STORY-LEVEL integration seam for "land on your last
// working project". It proves the WRITE side (8.8.28 records
// `User.lastActiveProjectId` at the switch points) and the READ side (8.8.27
// `resolveActiveWorkspace` / `resolveLastActiveContext` / `getActiveProject`)
// agree end-to-end, anchored on the PROJECT and deriving workspace → org.
//
// Unlike 8.8.28's unit suite (which calls the recording service methods
// directly), this seam drives writes through the real SERVER ACTIONS — the
// transport 8.8.28 actually wired — so it catches action↔service wiring drift
// (e.g. an org switch recording the wrong workspace), then reads back through
// the resolver. Reads use the real resolver against real Postgres; only the
// request-scoped edges are stubbed: `getSession` (no auth in the vitest env),
// `getWorkspaceContext` (no cookie/request scope for the project switcher),
// `next/headers` `cookies()` (an in-memory jar that captures what each switch
// action writes), and `next/cache` `revalidatePath` (no static-generation store
// in vitest). Every DB call goes through the real services. 8.8.30 covers
// the same path end-to-end through the browser.

const sessionUser = { id: '', email: '' };
let workspaceCtx: WorkspaceContext | null = null;
const cookieJar = new Map<string, string>();

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => (sessionUser.id ? { user: { ...sessionUser } } : null)),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: vi.fn(async () => workspaceCtx),
}));
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ host: 'localhost:3000', 'x-forwarded-proto': 'http' }),
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
}));
// setActiveProjectAction now calls revalidatePath (MOTIR-1559) — another
// request-scoped edge with no static-generation store under vitest; stub it.
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { setActiveProjectAction } = await import('@/app/(authed)/_project-actions');
const { switchWorkspaceAction, switchOrganizationAction, createWorkspaceAction } =
  await import('@/app/(authed)/_actions');

function actAs(user: User) {
  sessionUser.id = user.id;
  sessionUser.email = user.email;
}
function setWorkspaceCtx(userId: string, workspaceId: string) {
  workspaceCtx = { userId, workspaceId };
}
async function orgOf(workspaceId: string): Promise<string> {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}
async function pointerOf(userId: string): Promise<string | null> {
  const row = await db.user.findUniqueOrThrow({ where: { id: userId } });
  return row.lastActiveProjectId;
}

// A user who OWNS two workspaces in two DIFFERENT orgs (each createWorkspace with
// no organizationId mints its own org), each holding one project. wsA is created
// first, so it is the first-by-createdAt landing default; project P lives in the
// second workspace (wsC, org B) — the non-default target the pointer must beat.
async function twoOrgOwner() {
  const user = await createTestUser();
  const { workspace: wsA } = await workspacesService.createWorkspace({
    name: 'Alpha',
    ownerUserId: user.id,
  });
  const { workspace: wsC } = await workspacesService.createWorkspace({
    name: 'Charlie',
    ownerUserId: user.id,
  });
  const projectQ = await projectsService.createProject({
    workspaceId: wsA.id,
    actorUserId: user.id,
    name: 'Project Q',
  });
  const projectP = await projectsService.createProject({
    workspaceId: wsC.id,
    actorUserId: user.id,
    name: 'Project P',
  });
  return { user, wsA, wsC, projectP, projectQ };
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterEach(() => {
  sessionUser.id = '';
  sessionUser.email = '';
  workspaceCtx = null;
  cookieJar.clear();
  vi.clearAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('8.8.29 — last-active project seam (write actions ↔ read resolver)', () => {
  it('a project switch (action) drives the cold landing to that project’s workspace + org', async () => {
    const { user, wsA, wsC, projectP, projectQ } = await twoOrgOwner();
    actAs(user);

    // Work in project P (wsC, org B) via the project switcher action.
    setWorkspaceCtx(user.id, wsC.id);
    await setActiveProjectAction(projectP.id);

    const orgB = await orgOf(wsC.id);
    // No valid cookie → the pointer beats first-by-createdAt (wsA): land on wsC,
    // deriving org B and project P — read back through the resolver.
    expect(await workspacesService.resolveActiveWorkspace(user.id, null)).toBe(wsC.id);
    const ctx = await withUserContext(user.id, (tx) =>
      workspacesService.resolveLastActiveContext(user.id, tx),
    );
    expect(ctx).toEqual({ projectId: projectP.id, workspaceId: wsC.id, organizationId: orgB });
    expect((await projectsService.getActiveProject(user.id, wsC.id))?.id).toBe(projectP.id);

    // Switch to project Q (wsA) → the cold landing now follows to wsA.
    setWorkspaceCtx(user.id, wsA.id);
    await setActiveProjectAction(projectQ.id);
    expect(await pointerOf(user.id)).toBe(projectQ.id);
    expect(await workspacesService.resolveActiveWorkspace(user.id, null)).toBe(wsA.id);
  });

  it('a workspace switch (action) records the destination workspace’s active project', async () => {
    const { user, wsC, projectP } = await twoOrgOwner();
    actAs(user);

    await switchWorkspaceAction(wsC.id);

    // The action set the workspace cookie AND recorded wsC's active project
    // (recovered to its only project, P) onto the global pointer.
    expect(cookieJar.get(WORKSPACE_COOKIE_NAME)).toBe(wsC.id);
    expect(await pointerOf(user.id)).toBe(projectP.id);
    expect(await workspacesService.resolveActiveWorkspace(user.id, null)).toBe(wsC.id);
  });

  it('an org switch (action) records the re-pointed workspace’s active project', async () => {
    const { user, wsC, projectP } = await twoOrgOwner();
    actAs(user);
    const orgB = await orgOf(wsC.id);

    await switchOrganizationAction(orgB);

    // The org switch re-points the workspace cookie to the user's workspace in
    // org B (wsC) and records THAT workspace's active project.
    expect(cookieJar.get(ORGANIZATION_COOKIE_NAME)).toBe(orgB);
    expect(cookieJar.get(WORKSPACE_COOKIE_NAME)).toBe(wsC.id);
    expect(await pointerOf(user.id)).toBe(projectP.id);
    expect(await workspacesService.resolveActiveWorkspace(user.id, null)).toBe(wsC.id);
  });

  it('a brand-new workspace (action) records nothing until it has a project', async () => {
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'Seed WS', ownerUserId: user.id });
    actAs(user);

    const created = await createWorkspaceAction('Fresh');

    // The new workspace is active but empty → no project to land on yet.
    expect(cookieJar.get(WORKSPACE_COOKIE_NAME)).toBe(created.id);
    expect(await pointerOf(user.id)).toBeNull();
  });

  it('sync invariant — after a project switch, the global and membership pointers agree', async () => {
    const { user, wsC, projectP } = await twoOrgOwner();
    actAs(user);
    setWorkspaceCtx(user.id, wsC.id);

    await setActiveProjectAction(projectP.id);

    const membership = await db.workspaceMembership.findFirstOrThrow({
      where: { userId: user.id, workspaceId: wsC.id },
    });
    expect(await pointerOf(user.id)).toBe(projectP.id);
    expect(membership.activeProjectId).toBe(projectP.id);
  });

  describe('fallbacks remain intact', () => {
    it('no pointer → first-by-createdAt workspace, null last-active context', async () => {
      const { user, wsA } = await twoOrgOwner();

      expect(await workspacesService.resolveActiveWorkspace(user.id, null)).toBe(wsA.id);
      const ctx = await withUserContext(user.id, (tx) =>
        workspacesService.resolveLastActiveContext(user.id, tx),
      );
      expect(ctx).toBeNull();
    });

    it('a valid cookie still beats the last-active pointer', async () => {
      const { user, wsA, wsC, projectP } = await twoOrgOwner();
      actAs(user);
      setWorkspaceCtx(user.id, wsC.id);
      await setActiveProjectAction(projectP.id);

      // Pointer says wsC; a valid cookie pinned to wsA wins.
      expect(await workspacesService.resolveActiveWorkspace(user.id, wsA.id)).toBe(wsA.id);
    });

    it('the last project hard-removed (FK SetNull) clears the pointer and falls back cleanly', async () => {
      const { user, wsA, wsC, projectP } = await twoOrgOwner();
      actAs(user);
      setWorkspaceCtx(user.id, wsC.id);
      await setActiveProjectAction(projectP.id);
      expect(await pointerOf(user.id)).toBe(projectP.id);

      // Hard-delete P → the FK's onDelete: SetNull nulls the pointer.
      await db.project.delete({ where: { id: projectP.id } });
      expect(await pointerOf(user.id)).toBeNull();

      // Cold resolve degrades to first-by-createdAt (wsA).
      expect(await workspacesService.resolveActiveWorkspace(user.id, null)).toBe(wsA.id);
    });

    it('an inaccessible last-active workspace is filtered, falling back to the first accessible', async () => {
      const { user: owner, wsA, wsC, projectP } = await twoOrgOwner();
      const member = await createTestUser();
      // wsA first → first-by-createdAt for the member too; both addMembers
      // upward-auto-join the workspace's org.
      await workspacesService.addMember({ userId: member.id, workspaceId: wsA.id });
      await workspacesService.addMember({ userId: member.id, workspaceId: wsC.id });

      actAs(member);
      setWorkspaceCtx(member.id, wsC.id);
      await setActiveProjectAction(projectP.id);
      expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsC.id);

      // Revoke the member's org-B membership → wsC's access gate now denies it.
      const orgB = await orgOf(wsC.id);
      await organizationsService.removeMember({
        organizationId: orgB,
        userId: member.id,
        actorUserId: owner.id,
      });

      expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsA.id);
    });
  });
});
