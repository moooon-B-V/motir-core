import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from './helpers/db';

const { createUser } = usersService;
const { createWorkspace } = workspacesService;

// Multi-tenant isolation — direct-DB RLS proof (Subtask 1.2.7).
//
// Companion to tests/workspace-rls.test.ts. That file proves the
// withWorkspaceContext helper + the visibility policies. This file is the
// cross-tenant ISOLATION proof the Story-1.2 AC asks for: two users, each
// owning their own workspace, must never see or mutate each other's rows
// through the RLS layer — plus the FK-cascade contract that backs hard
// deletes.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS does nothing under it regardless of
// FORCE ROW LEVEL SECURITY. Every RLS assertion below therefore runs inside
// a transaction that `SET LOCAL ROLE prodect_app` (the NOSUPERUSER
// NOBYPASSRLS role created by the add_workspace_rls migration). Without that
// role switch each assertion would assert the OPPOSITE of reality (a
// superuser sees all rows). The role reverts at txn end. This mirrors
// tests/workspace-rls.test.ts's asAppRole helper exactly.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface TenantFixture {
  userAId: string;
  userBId: string;
  workspaceAId: string;
  workspaceBId: string;
}

// Two independent tenants: user A owns workspace A, user B owns workspace
// B. Neither is a member of the other's workspace — the clean cross-tenant
// setup the isolation policies must enforce.
async function makeTenants(): Promise<TenantFixture> {
  const userA = await createUser({
    email: 'tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Tenant A',
  });
  const userB = await createUser({
    email: 'tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Tenant B',
  });
  const a = await createWorkspace({ name: 'Workspace A', ownerUserId: userA.id });
  const b = await createWorkspace({ name: 'Workspace B', ownerUserId: userB.id });

  return {
    userAId: userA.id,
    userBId: userB.id,
    workspaceAId: a.workspace.id,
    workspaceBId: b.workspace.id,
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally pins the user +
 * workspace GUCs the RLS policies read and (b) drops to the non-bypass
 * `prodect_app` role for the duration of the transaction — the role switch
 * is what makes RLS actually bite (the default superuser bypasses it). The
 * role reverts when the transaction ends.
 *
 * Mirrors tests/workspace-rls.test.ts's asAppRole. We do NOT fold the
 * role-switch into withWorkspaceContext: production connects as prodect_app
 * via its DATABASE_URL, not via a per-query role switch — see
 * prodect_plan/PRODECT_FINDINGS.md #5.
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

describe('multi-tenant RLS — read isolation', () => {
  it('with NO GUC set, the prodect_app role sees zero workspace rows', async () => {
    await makeTenants();
    const rows = await asAppRole({}, (tx) => tx.workspace.findMany());
    expect(rows).toEqual([]);
  });

  it('with NO GUC set, the prodect_app role sees zero workspace_membership rows', async () => {
    await makeTenants();
    const rows = await asAppRole({}, (tx) => tx.workspaceMembership.findMany());
    expect(rows).toEqual([]);
  });

  it("with the GUC for tenant A, only A's workspace is visible — never B's", async () => {
    const fx = await makeTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.workspace.findMany(),
    );
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.workspaceAId]);
    expect(ids).not.toContain(fx.workspaceBId);
  });

  it("with the GUC for tenant A, only A's membership rows are visible — never B's", async () => {
    const fx = await makeTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.workspaceMembership.findMany(),
    );
    const workspaceIds = rows.map((r) => r.workspaceId);
    const userIds = rows.map((r) => r.userId);
    expect(workspaceIds).toEqual([fx.workspaceAId]);
    expect(userIds).toEqual([fx.userAId]);
    expect(workspaceIds).not.toContain(fx.workspaceBId);
    expect(userIds).not.toContain(fx.userBId);
  });

  it("tenant A cannot SELECT tenant B's workspace by id", async () => {
    const fx = await makeTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.workspace.findMany({ where: { id: fx.workspaceBId } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('multi-tenant RLS — write isolation', () => {
  it('INSERT into workspace_membership is denied for prodect_app (no INSERT policy → 42501)', async () => {
    const fx = await makeTenants();
    // The add_workspace_rls migration deliberately defines NO INSERT policy
    // on workspace_membership (tenant-root inserts are gated at the app
    // layer — see the migration's header comment). With RLS enabled +
    // FORCED and no permissive INSERT policy, every INSERT by the non-bypass
    // role is denied. Postgres raises insufficient_privilege (42501), which
    // the Prisma pg driver surfaces as a DriverAdapterError whose underlying
    // postgres `cause.code` is the SQLSTATE.
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceBId }, (tx) =>
        tx.workspaceMembership.create({
          data: { userId: fx.userAId, workspaceId: fx.workspaceBId, role: 'member' },
        }),
      ),
    ).rejects.toMatchObject({
      // The pg DriverAdapterError carries the raw Postgres SQLSTATE on
      // `cause.code` (42501 = insufficient_privilege, the RLS denial).
      cause: { code: '42501' },
    });

    // Sanity: no cross-tenant membership leaked in (asserted as superuser).
    const leaked = await db.workspaceMembership.findFirst({
      where: { userId: fx.userAId, workspaceId: fx.workspaceBId },
    });
    expect(leaked).toBeNull();
  });

  it('UPDATE on a workspace not matching the active GUC affects zero rows (P2025)', async () => {
    const fx = await makeTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.workspace.update({
          where: { id: fx.workspaceBId },
          data: { name: 'Hijacked by A' },
        }),
      ),
    ).rejects.toMatchObject({
      // The workspace_mutate_active policy's USING clause hides B's row from
      // A's UPDATE; the WHERE matches zero rows, which Prisma raises as
      // P2025 (record-not-found) — exactly the RLS-denied shape.
      code: 'P2025',
    });

    // Sanity: B's workspace name is untouched (asserted as superuser).
    const b = await db.workspace.findUnique({ where: { id: fx.workspaceBId } });
    expect(b?.name).toBe('Workspace B');
  });
});

describe('multi-tenant — FK cascade (independent of RLS)', () => {
  // Cascades are FK-level and apply regardless of role, so these run as the
  // default superuser. They back the hard-delete contract: deleting a
  // workspace or a user removes the dependent membership rows.

  it('deleting a workspace cascades its membership rows away', async () => {
    const userA = await createUser({
      email: 'cascade-ws@example.com',
      password: 'hunter2hunter2',
      name: 'Cascade WS',
    });
    const { workspace } = await createWorkspace({
      name: 'Cascade WS Workspace',
      ownerUserId: userA.id,
    });
    expect(await db.workspaceMembership.count({ where: { workspaceId: workspace.id } })).toBe(1);

    await db.workspace.delete({ where: { id: workspace.id } });

    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(await db.workspaceMembership.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('deleting a user cascades their membership rows away', async () => {
    const userA = await createUser({
      email: 'cascade-user@example.com',
      password: 'hunter2hunter2',
      name: 'Cascade User',
    });
    const { workspace } = await createWorkspace({
      name: 'Cascade User Workspace',
      ownerUserId: userA.id,
    });
    expect(await db.workspaceMembership.count({ where: { userId: userA.id } })).toBe(1);

    await db.user.delete({ where: { id: userA.id } });

    expect(await db.workspaceMembership.count({ where: { userId: userA.id } })).toBe(0);
    // The workspace itself survives (only the membership cascaded).
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
  });
});
