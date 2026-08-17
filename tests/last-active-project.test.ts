import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { withUserContext } from '@/lib/workspaces/context';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
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
  await adminDb.$disconnect();
});

async function orgIdOfWorkspace(workspaceId: string): Promise<string> {
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}

async function makeProject(ownerUserId: string, workspaceId: string, name: string) {
  return projectsService.createProject({ workspaceId, actorUserId: ownerUserId, name });
}

async function pointerOf(userId: string): Promise<string | null> {
  const row = await adminDb.user.findUniqueOrThrow({ where: { id: userId } });
  return row.lastActiveProjectId;
}

// The resolver's own first read, in isolation: can this user SEE that project
// from the half-context the resolver runs in? Every "returns null" assertion in
// this file is ambiguous without it — see the MOTIR-2886 block below.
function readProjectAsUser(userId: string, projectId: string) {
  return withUserContext(userId, (tx) => projectRepository.findById(projectId, tx));
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

    const row = await adminDb.user.findUniqueOrThrow({ where: { id: owner.id } });
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

    const row = await adminDb.user.findUniqueOrThrow({ where: { id: owner.id } });
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

    await adminDb.project.delete({ where: { id: project.id } });

    const row = await adminDb.user.findUniqueOrThrow({ where: { id: owner.id } });
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

  it('returns null when the pointer is unset — because of the POINTER, not a dead project read', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const project = await makeProject(owner.id, workspace.id, 'Acme Project');

    // The two intermediates that make the null below mean what the title says.
    expect(await pointerOf(owner.id)).toBeNull();
    // …and the read the resolver would have made IS live in this very context,
    // so a null cannot be coming from there (MOTIR-2886).
    expect(await readProjectAsUser(owner.id, project.id)).not.toBeNull();

    const ctx = await withUserContext(owner.id, (tx) =>
      workspacesService.resolveLastActiveContext(owner.id, tx),
    );

    expect(ctx).toBeNull();
  });

  it('returns null when the user no longer passes the workspace access gate', async () => {
    const { owner, member, wsB, projectB } = await twoWorkspaceMember();
    const orgB = await orgIdOfWorkspace(wsB.id);
    await workspacesService.recordLastActiveProject(member.id, projectB.id);

    // Revoke the member's org membership for B → the gate now denies wsB. The
    // WORKSPACE membership row survives, which is the whole point of the 6.10.4
    // gate — and, since MOTIR-2886, of keeping the new `project` read arm keyed
    // on workspace membership alone.
    await organizationsService.removeMember({
      organizationId: orgB,
      userId: member.id,
      actorUserId: owner.id,
    });

    // The intermediates, in the order the resolver hits them: the pointer is
    // set, the project still RESOLVES, and the gate is what says no. Assert the
    // gate's own verdict — before MOTIR-2886 the read above returned null and
    // this test passed without the gate ever executing.
    expect(await pointerOf(member.id)).toBe(projectB.id);
    expect(await readProjectAsUser(member.id, projectB.id)).not.toBeNull();
    const access = await withUserContext(member.id, (tx) =>
      organizationsService.resolveWorkspaceAccess(member.id, wsB.id, tx),
    );
    expect(access).toBeNull();

    const ctx = await withUserContext(member.id, (tx) =>
      workspacesService.resolveLastActiveContext(member.id, tx),
    );

    expect(ctx).toBeNull();
  });
});

// MOTIR-2886 — the RLS arm the resolver depends on, asserted in both directions.
//
// `resolveLastActiveContext` runs inside `withUserContext`, which binds only
// `app.user_id`. `project`'s pre-existing policies key on `app.workspace_id` /
// `app.system_admin` / `accessLevel = 'public'`, so under `motir_app` NO arm
// admitted this read: it returned null and raised nothing, and every "returns
// null" assertion in the suite above passed for the wrong reason.
// `project_user_membership_read` (20260817140000) closes it.
//
// ⚠️ THE ADMIT DIRECTION COMES FIRST, and the denial assertions are the ones
// that would keep passing if the arm were dropped tomorrow — a table nobody can
// read satisfies every cross-tenant test ever written. This block lives here,
// beside the feature it unbroke, rather than in `tests/permissions/`, because
// the arm exists for exactly one caller and the ordering above is what it buys.
describe('project_user_membership_read (the user-context arm)', () => {
  it('ADMITS a member reading a project of their own workspace with no workspace bound', async () => {
    const { member, projectA, projectB } = await twoWorkspaceMember();

    // Both workspaces, not just the default one — reaching the NON-default one
    // is the resolver's whole job.
    expect(await asAppRole({ userId: member.id }, (tx) => selectProject(tx, projectA.id))).toEqual([
      { id: projectA.id },
    ]);
    expect(await asAppRole({ userId: member.id }, (tx) => selectProject(tx, projectB.id))).toEqual([
      { id: projectB.id },
    ]);
    // …and through the repository the resolver actually calls, not only raw SQL.
    expect((await readProjectAsUser(member.id, projectB.id))?.id).toBe(projectB.id);
  });

  it('REFUSES a user who is not a member of the project’s workspace', async () => {
    const { projectB } = await twoWorkspaceMember();
    const stranger = await createTestUser();
    await workspacesService.createWorkspace({ name: 'Stranger', ownerUserId: stranger.id });

    expect(await asAppRole({ userId: stranger.id }, (tx) => selectProject(tx, projectB.id))).toEqual(
      [],
    );
  });

  it('grants a TENANT-bound request nothing about the user’s other workspaces', async () => {
    const { member, wsA, projectA, projectB } = await twoWorkspaceMember();
    const bound = { userId: member.id, workspaceId: wsA.id };

    // Bound to wsA the member sees wsA's project and NOT wsB's — even though
    // they are a member of both. The arm is gated on the workspace GUC being
    // UNBOUND precisely so it cannot widen an ordinary tenant request; drop that
    // gate and this is the assertion that goes red.
    expect(await asAppRole(bound, (tx) => selectProject(tx, projectA.id))).toEqual([
      { id: projectA.id },
    ]);
    expect(await asAppRole(bound, (tx) => selectProject(tx, projectB.id))).toEqual([]);
  });

  it('leaves WITH CHECK untouched — the arm is SELECT-only', async () => {
    const { member, wsA, wsB } = await twoWorkspaceMember();

    // The member belongs to BOTH workspaces, so if the arm were `FOR ALL` the
    // insert below would find a permissive policy to pass. 42501 is the
    // row-security violation (`tests/permissions/publicProjectAccess.test.ts`
    // pins the same code for the public arm).
    await expect(
      asAppRole(
        { userId: member.id, workspaceId: wsA.id },
        (tx) => tx.$executeRaw`
          INSERT INTO "project" ("id", "workspaceId", "name", "slug", "identifier", "accessLevel", "createdAt", "updatedAt")
          VALUES (${'smuggled-' + wsB.id}, ${wsB.id}, 'Smuggled', 'smuggled', 'SMG', 'private', now(), now())
        `,
      ),
    ).rejects.toMatchObject({ meta: { driverAdapterError: { cause: { code: '42501' } } } });
  });
});

/**
 * Run `fn` as the non-bypass `motir_app` role, binding only the GUCs `ctx`
 * names — so `asAppRole({ userId })` is exactly the half-context
 * `withUserContext` opens. A local copy of the helper in
 * `tests/permissions/publicProjectAccess.test.ts` / `tests/project-rls.test.ts`,
 * for the reason those files give.
 *
 * The role switch is what makes this block independent of `TEST_DB_APP_ROLE`:
 * under the flag `db` is already `motir_app` and this is a no-op; without it
 * `db` is the BYPASSRLS owner and the switch is the only thing that puts the
 * policies in the path. Every assertion above holds identically in both modes —
 * a mode-split expectation here would leave the arm unproved in the mode CI
 * actually runs.
 */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

function selectProject(tx: Prisma.TransactionClient, id: string) {
  return tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "project" WHERE "id" = ${id}`;
}

describe('resolveActiveWorkspace precedence (cookie → last-active → first)', () => {
  it('lands on the last-active project’s workspace, NOT the first-by-createdAt one', async () => {
    const { member, wsB, projectB } = await twoWorkspaceMember();
    await workspacesService.recordLastActiveProject(member.id, projectB.id);

    // No cookie → the last-active project (in wsB) wins over the first (wsA).
    expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsB.id);
  });

  it('falls back to first-by-createdAt when there is no last-active pointer', async () => {
    const { member, wsA, wsB, projectB } = await twoWorkspaceMember();

    // The intermediate: there really is no pointer, so the fallback is the only
    // branch left to take…
    expect(await pointerOf(member.id)).toBeNull();
    expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsA.id);

    // …and the branch it falls back FROM is live. Without this the assertion
    // above passes just as happily when the last-active branch is dead, which is
    // exactly what MOTIR-2886 was: the fallback was taken unconditionally.
    await workspacesService.recordLastActiveProject(member.id, projectB.id);
    expect(await workspacesService.resolveActiveWorkspace(member.id, null)).toBe(wsB.id);
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

// Subtask 8.8.28 — the WRITE call sites that feed 8.8.27's resolver. Each point
// where the active project changes (directly, or as a consequence of switching
// workspace/org, or creating a workspace) must mirror the current active project
// onto `User.lastActiveProjectId`. These lock the two service seams the four
// switch actions call: setActiveProject (the direct switch) and
// recordLastActiveProjectForWorkspace (the workspace-derived switches). The full
// action→resolve stamp is asserted in 8.8.29's seam + 8.8.30's E2E.
describe('8.8.28 — recording the global pointer at the switch points', () => {
  describe('setActiveProject (the primary project-switch point)', () => {
    it('mirrors the selected project onto User.lastActiveProjectId', async () => {
      const owner = await createTestUser();
      const { workspace } = await workspacesService.createWorkspace({
        name: 'Acme',
        ownerUserId: owner.id,
      });
      const project = await makeProject(owner.id, workspace.id, 'Acme Project');

      await projectsService.setActiveProject({
        userId: owner.id,
        workspaceId: workspace.id,
        projectId: project.id,
      });

      const row = await adminDb.user.findUniqueOrThrow({ where: { id: owner.id } });
      expect(row.lastActiveProjectId).toBe(project.id);
    });

    it('records the NEW project when switching between two projects', async () => {
      const owner = await createTestUser();
      const { workspace } = await workspacesService.createWorkspace({
        name: 'Acme',
        ownerUserId: owner.id,
      });
      const p1 = await makeProject(owner.id, workspace.id, 'First Project');
      const p2 = await makeProject(owner.id, workspace.id, 'Second Project');

      await projectsService.setActiveProject({
        userId: owner.id,
        workspaceId: workspace.id,
        projectId: p1.id,
      });
      await projectsService.setActiveProject({
        userId: owner.id,
        workspaceId: workspace.id,
        projectId: p2.id,
      });

      const row = await adminDb.user.findUniqueOrThrow({ where: { id: owner.id } });
      expect(row.lastActiveProjectId).toBe(p2.id);
    });

    it('does NOT touch the global pointer when CLEARING the active project (null)', async () => {
      const owner = await createTestUser();
      const { workspace } = await workspacesService.createWorkspace({
        name: 'Acme',
        ownerUserId: owner.id,
      });
      const project = await makeProject(owner.id, workspace.id, 'Acme Project');
      await projectsService.setActiveProject({
        userId: owner.id,
        workspaceId: workspace.id,
        projectId: project.id,
      });

      // Clearing the per-membership pointer must NOT wipe the global landing
      // pointer — there is no project to land on, so we leave the last one.
      await projectsService.setActiveProject({
        userId: owner.id,
        workspaceId: workspace.id,
        projectId: null,
      });

      const row = await adminDb.user.findUniqueOrThrow({ where: { id: owner.id } });
      expect(row.lastActiveProjectId).toBe(project.id);
    });
  });

  describe('recordLastActiveProjectForWorkspace (workspace / org switch + workspace create)', () => {
    it('records the destination workspace’s active project', async () => {
      const { member, wsB, projectB } = await twoWorkspaceMember();

      await projectsService.recordLastActiveProjectForWorkspace(member.id, wsB.id);

      const row = await adminDb.user.findUniqueOrThrow({ where: { id: member.id } });
      expect(row.lastActiveProjectId).toBe(projectB.id);
    });

    it('is a silent no-op for a freshly-created workspace with no project yet', async () => {
      const owner = await createTestUser();
      const { workspace } = await workspacesService.createWorkspace({
        name: 'Empty',
        ownerUserId: owner.id,
      });

      await projectsService.recordLastActiveProjectForWorkspace(owner.id, workspace.id);

      const row = await adminDb.user.findUniqueOrThrow({ where: { id: owner.id } });
      expect(row.lastActiveProjectId).toBeNull();
    });

    it('never throws and leaves the pointer intact for a workspace the user cannot access', async () => {
      const { member, wsA, projectA } = await twoWorkspaceMember();
      // Establish a valid pointer from a workspace the member IS in.
      await projectsService.recordLastActiveProjectForWorkspace(member.id, wsA.id);
      const before = await adminDb.user.findUniqueOrThrow({ where: { id: member.id } });
      expect(before.lastActiveProjectId).toBe(projectA.id);

      // A workspace the member is NOT a member of (a forged/stale id at a switch
      // point): getActiveProject resolves null → best-effort no-op, no throw,
      // pointer unchanged.
      const stranger = await createTestUser();
      const { workspace: foreign } = await workspacesService.createWorkspace({
        name: 'Foreign',
        ownerUserId: stranger.id,
      });
      await makeProject(stranger.id, foreign.id, 'Foreign Project');

      await expect(
        projectsService.recordLastActiveProjectForWorkspace(member.id, foreign.id),
      ).resolves.toBeUndefined();

      const after = await adminDb.user.findUniqueOrThrow({ where: { id: member.id } });
      expect(after.lastActiveProjectId).toBe(projectA.id);
    });
  });
});
