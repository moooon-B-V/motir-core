import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { SEED_SOURCE_PLATFORM_STARTER } from '@/lib/projectRepos/vocabulary';
import { truncateAuthTables } from '../helpers/db';

// `project_repository` isolation — direct-DB RLS proof (Story MOTIR-1775 ·
// MOTIR-1780), the tenancy half of this card's acceptance: "a project row is
// invisible under another workspace's RLS context."
//
// Mirrors tests/project-rls.test.ts for the new workspace-scoped table the card
// ships. Two independent tenants, each with a workspace + project + one repo-set
// row, must never see or mutate the other's rows once we drop to the non-bypass
// `prodect_app` role.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE ROW
// LEVEL SECURITY. Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE prodect_app`. WITHOUT the role switch each assertion would
// assert the OPPOSITE of reality. The role reverts at txn end. `asAppRole` is
// intentionally a local copy of the helper in project-rls.test.ts /
// multi-tenant-rls.test.ts — see those files for why it is not hoisted yet.
//
// The policy under test (20260730115208_add_project_repository_set): one PERMISSIVE
// `FOR ALL` policy `project_repository_active_workspace`, USING + WITH CHECK both
// predicating on `"workspace_id" = current_setting('app.workspace_id', true)`. So:
//   * with no GUC bound the predicate is NULL → every row hidden (the safe failure);
//   * SELECT under workspace-A's GUC hides B's row (USING);
//   * UPDATE/DELETE of B's row from A's GUC matches zero rows → P2025;
//   * INSERT carrying workspace_id = B from A's GUC fails WITH CHECK → 42501.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface RepoSetTenantFixture {
  userAId: string;
  userBId: string;
  workspaceAId: string;
  workspaceBId: string;
  projectAId: string;
  projectBId: string;
  rowAId: string;
  rowBId: string;
}

/**
 * Two independent tenants, each owning a workspace with a project that has ONE
 * repo-set row. Setup runs as the superuser (BYPASSRLS) — that is fine; the
 * assertions are what run as `prodect_app` and what RLS bites on.
 */
async function makeRepoSetTenants(): Promise<RepoSetTenantFixture> {
  const userA = await usersService.createUser({
    email: 'repo-set-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Repo Set Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'repo-set-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Repo Set Tenant B',
  });
  const a = await workspacesService.createWorkspace({
    name: 'Repo Set Workspace A',
    ownerUserId: userA.id,
  });
  const b = await workspacesService.createWorkspace({
    name: 'Repo Set Workspace B',
    ownerUserId: userB.id,
  });
  const projectA = await projectsService.createProject({
    workspaceId: a.workspace.id,
    actorUserId: userA.id,
    name: 'Alpha',
    identifier: 'ALPHA',
  });
  const projectB = await projectsService.createProject({
    workspaceId: b.workspace.id,
    actorUserId: userB.id,
    name: 'Bravo',
    identifier: 'BRAVO',
  });
  const rowA = await db.projectRepo.create({
    data: {
      workspaceId: a.workspace.id,
      projectId: projectA.id,
      role: 'web',
      name: 'alpha-web',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      position: 'a0',
    },
  });
  const rowB = await db.projectRepo.create({
    data: {
      workspaceId: b.workspace.id,
      projectId: projectB.id,
      role: 'web',
      name: 'bravo-web',
      seedSource: SEED_SOURCE_PLATFORM_STARTER,
      position: 'a0',
    },
  });

  return {
    userAId: userA.id,
    userBId: userB.id,
    workspaceAId: a.workspace.id,
    workspaceBId: b.workspace.id,
    projectAId: projectA.id,
    projectBId: projectB.id,
    rowAId: rowA.id,
    rowBId: rowB.id,
  };
}

/**
 * Run `fn` in a transaction that (a) optionally pins the user + workspace GUCs the
 * RLS policies read and (b) drops to the non-bypass `prodect_app` role for the
 * duration. The role switch is what makes RLS actually bite; it reverts at txn end.
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
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('project_repository RLS — read isolation', () => {
  it('with NO GUC set, the prodect_app role sees zero repo-set rows', async () => {
    await makeRepoSetTenants();
    expect(await asAppRole({}, (tx) => tx.projectRepo.findMany())).toEqual([]);
  });

  it("with workspace-A's GUC bound, only A's row is visible — never B's", async () => {
    const fx = await makeRepoSetTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.projectRepo.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.rowAId]);
    expect(rows.map((r) => r.name)).toEqual(['alpha-web']);
  });

  it("tenant A cannot SELECT tenant B's row by id", async () => {
    const fx = await makeRepoSetTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.projectRepo.findMany({ where: { id: fx.rowBId } }),
    );
    expect(rows).toEqual([]);
  });

  it("tenant A cannot reach B's rows by naming B's PROJECT id either", async () => {
    // The gate is the row's OWN workspace_id, and RLS does not traverse foreign
    // keys — so knowing a foreign project id buys nothing.
    const fx = await makeRepoSetTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.projectRepo.findMany({ where: { projectId: fx.projectBId } }),
    );
    expect(rows).toEqual([]);
  });

  it("the LEFT JOIN read is invisible across tenants too (A's context returns no B rows)", async () => {
    // The repository's set read is raw SQL, so it is worth proving the policy applies
    // to it and not only to the Prisma-generated queries.
    const fx = await makeRepoSetTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceAId },
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
        SELECT pr."id" AS "id"
        FROM "project_repository" pr
        LEFT JOIN "github_repo" gr ON gr."id" = pr."github_repo_id"
        ORDER BY pr."position" ASC
      `,
    );
    expect(rows.map((r) => r.id)).toEqual([fx.rowAId]);
  });
});

describe('project_repository RLS — write isolation', () => {
  it('UPDATE of a row outside the active workspace affects zero rows (P2025)', async () => {
    const fx = await makeRepoSetTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.projectRepo.update({ where: { id: fx.rowBId }, data: { name: 'hijacked-by-a' } }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    // Sanity (as superuser): B's row is untouched.
    const b = await db.projectRepo.findUnique({ where: { id: fx.rowBId } });
    expect(b?.name).toBe('bravo-web');
  });

  it('DELETE of a row outside the active workspace removes nothing', async () => {
    const fx = await makeRepoSetTenants();
    const deleted = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.projectRepo.deleteMany({ where: { id: fx.rowBId } }),
    );
    expect(deleted.count).toBe(0);
    expect(await db.projectRepo.findUnique({ where: { id: fx.rowBId } })).not.toBeNull();
  });

  it('INSERT with a workspace_id not matching the active GUC is denied (42501)', async () => {
    const fx = await makeRepoSetTenants();
    // The policy's WITH CHECK requires the NEW row's workspace_id to equal
    // current_setting('app.workspace_id'). Smuggling a row into B's workspace from
    // A's context fails WITH CHECK; Postgres raises insufficient_privilege (42501),
    // which the Prisma pg driver surfaces as the underlying `cause.code`.
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.projectRepo.create({
          data: {
            workspaceId: fx.workspaceBId,
            projectId: fx.projectBId,
            role: 'api',
            name: 'smuggled',
            seedSource: SEED_SOURCE_PLATFORM_STARTER,
            position: 'a1',
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // Sanity (as superuser): no smuggled row landed in B's project.
    expect(
      await db.projectRepo.findFirst({ where: { projectId: fx.projectBId, name: 'smuggled' } }),
    ).toBeNull();
  });

  it('a tenant cannot MOVE its own row into another workspace (WITH CHECK on the update)', async () => {
    // The re-tenanting attack: the row is visible to A (USING passes on the OLD row),
    // but the NEW row's workspace_id must also satisfy WITH CHECK, so the write fails.
    const fx = await makeRepoSetTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.projectRepo.update({
          where: { id: fx.rowAId },
          data: { workspaceId: fx.workspaceBId },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const a = await db.projectRepo.findUnique({ where: { id: fx.rowAId } });
    expect(a?.workspaceId).toBe(fx.workspaceAId);
  });
});
