import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { organizationsService } from '@/lib/services/organizationsService';
import { withUserContext } from '@/lib/workspaces/context';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// Subtask 8.8.27 — the GLOBAL last-active-project resolver engine. On a fresh
// session/device (no valid workspace cookie) a user should land back in the
// workspace of the PROJECT they last worked in, deriving workspace + org from
// that project (project → workspace → org), instead of the first-by-createdAt
// workspace. Real Postgres, no mocks (the project rule). This suite locks: the
// `User.lastActiveProjectId` write (LWW), the resolver's set/unset/inaccessible
// branches, and `resolveActiveWorkspace`'s new precedence
// (valid cookie → last-active project → first-by-createdAt). 8.8.28 wires the
// write call sites; 8.8.29/8.8.30 add the seam + E2E coverage.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function orgIdOfWorkspace(workspaceId: string): Promise<string> {
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}

async function makeProject(ownerUserId: string, workspaceId: string, name: string) {
  return projectsService.createProject({ workspaceId, actorUserId: ownerUserId, name });
}

// A user who is a member of TWO org-backed workspaces — wsA created first (so it
// is the first-by-createdAt default), wsB second with its own project. The
// `member` is added to both (each addMember upward-auto-joins the org), so both
// are accessible until we explicitly revoke one. Returns the actors + ids the
// tests assert against.
async function twoWorkspaceMember() {
  const owner = await createTestUser();
  const { workspace: wsA } = await workspacesService.createWorkspace({
    name: 'Alpha',
    ownerUserId: owner.id,
  });
  const { workspace: wsB } = await workspacesService.createWorkspace({
    name: 'Beta',
    ownerUserId: owner.id,
  });
  const projectA = await makeProject(owner.id, wsA.id, 'Alpha Project');
  const projectB = await makeProject(owner.id, wsB.id, 'Beta Project');

  const member = await createTestUser();
  // wsA first → its membership createdAt sorts first (the default landing).
  await workspacesService.addMember({ userId: member.id, workspaceId: wsA.id });
  await workspacesService.addMember({ userId: member.id, workspaceId: wsB.id });

  return { owner, member, wsA, wsB, projectA, projectB };
}

describe('recordLastActiveProject (the global pointer write)', () => {
  it('sets User.lastActiveProjectId to the recorded project', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const project = await makeProject(owner.id, workspace.id, 'Acme Project');

    await workspacesService.recordLastActiveProject(owner.id, project.id);

    const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.lastActiveProjectId).toBe(project.id);
  });

  it('is last-writer-wins — a second record overwrites the first', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const p1 = await makeProject(owner.id, workspace.id, 'First Project');
    const p2 = await makeProject(owner.id, workspace.id, 'Second Project');

    await workspacesService.recordLastActiveProject(owner.id, p1.id);
    await workspacesService.recordLastActiveProject(owner.id, p2.id);

    const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.lastActiveProjectId).toBe(p2.id);
  });

  it('clears the pointer (onDelete: SetNull) when the project is hard-deleted', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const project = await makeProject(owner.id, workspace.id, 'Doomed Project');
    await workspacesService.recordLastActiveProject(owner.id, project.id);

    await db.project.delete({ where: { id: project.id } });

    const row = await db.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(row.lastActiveProjectId).toBeNull();
  });
});

describe('resolveLastActiveContext (project → workspace → org)', () => {
  it('returns the project + its workspace + org when set and accessible', async () => {
    const { owner, wsB, projectB } = await twoWorkspaceMember();
    const orgB = await orgIdOfWorkspace(wsB.id);
    await workspacesService.recordLastActiveProject(owner.id, projectB.id);

    const ctx = await withUserContext(owner.id, (tx) =>
      workspacesService.resolveLastActiveContext(owner.id, tx),
    );

    expect(ctx).toEqual({
      projectId: projectB.id,
      workspaceId: wsB.id,
      organizationId: orgB,
    });
  });

  it('returns null when the pointer is unset', async () => {
    const owner = await createTestUser();
    await workspacesService.createWorkspace({ name: 'Acme', ownerUserId: owner.id });

    const ctx = await withUserContext(owner.id, (tx) =>
      workspacesService.resolveLastActiveContext(owner.id, tx),
    );

    expect(ctx).toBeNull();
  });

  it('returns null when the user no longer passes the workspace access gate', async () => {
    const { owner, member, wsB, projectB } = await twoWorkspaceMember();
    const orgB = await orgIdOfWorkspace(wsB.id);
    await workspacesService.recordLastActiveProject(member.id, projectB.id);

    // Revoke the member's org membership for B → the gate now denies wsB.
    await organizationsService.removeMember({
      organizationId: orgB,
      userId: member.id,
      actorUserId: owner.id,
    });

    const ctx = await withUserContext(member.id, (tx) =>
      workspacesService.resolveLastActiveContext(member.id, tx),
    );

    expect(ctx).toBeNull();
  });
});

describe('resolveActiveWorkspace precedence (cookie → last-active → first)', () => {
  it('lands on the last-active project’s workspace, NOT the first-by-createdAt one', async () => {
    const { member, wsB, projectB } = await twoWorkspaceMember();
    await workspacesService.recordLastActiveProject(member.id, projectB.id);

    // No cookie → the last-active project (in wsB) wins over the first (wsA).
    expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsB.id);
  });

  it('falls back to first-by-createdAt when there is no last-active pointer', async () => {
    const { member, wsA } = await twoWorkspaceMember();

    expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsA.id);
  });

  it('a valid cookie still wins over the last-active project', async () => {
    const { member, wsA, projectB } = await twoWorkspaceMember();
    await workspacesService.recordLastActiveProject(member.id, projectB.id);

    // Cookie pinned to wsA → wsA, even though the last-active project is in wsB.
    expect(await workspacesService.resolveActiveWorkspace(member.id, wsA.id)).toBe(wsA.id);
  });

  it('falls back cleanly when the last-active project is no longer accessible', async () => {
    const { owner, member, wsA, wsB, projectB } = await twoWorkspaceMember();
    const orgB = await orgIdOfWorkspace(wsB.id);
    await workspacesService.recordLastActiveProject(member.id, projectB.id);

    // Last-active resolves to wsB while accessible…
    expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsB.id);

    // …then revoke wsB access → resolution degrades to the first accessible (wsA).
    await organizationsService.removeMember({
      organizationId: orgB,
      userId: member.id,
      actorUserId: owner.id,
    });

    expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsA.id);
  });
});
