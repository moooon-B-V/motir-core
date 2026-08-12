import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from './helpers/adminDb';
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
// a transaction that `SET LOCAL ROLE motir_app` (the NOSUPERUSER
// NOBYPASSRLS role created by the add_workspace_rls migration). Without that
// role switch each assertion would assert the OPPOSITE of reality (a
// superuser sees all rows). The role reverts at txn end. This mirrors
// tests/workspace-rls.test.ts's asAppRole helper exactly.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
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
 * `motir_app` role for the duration of the transaction — the role switch
 * is what makes RLS actually bite (the default superuser bypasses it). The
 * role reverts when the transaction ends.
 *
 * Mirrors tests/workspace-rls.test.ts's asAppRole. We do NOT fold the
 * role-switch into withWorkspaceContext: production connects as motir_app
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
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('multi-tenant RLS — read isolation', () => {
  it('with NO GUC set, the motir_app role sees zero workspace rows', async () => {
    await makeTenants();
    const rows = await asAppRole({}, (tx) => tx.workspace.findMany());
    expect(rows).toEqual([]);
  });

  it('with NO GUC set, the motir_app role sees zero workspace_membership rows', async () => {
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
  it("INSERT of a membership into ANOTHER tenant's workspace is denied (42501)", async () => {
    const fx = await makeTenants();
    // ▶ AMENDED by MOTIR-2512. This case previously asserted that ANY insert
    // into workspace_membership was denied, because add_workspace_rls defined no
    // INSERT policy at all. That was true and was a DEFECT, not a guarantee: it
    // also denied the founder's own owner-row and the invite flow, so no tenant
    // could be created as the runtime role. `membership_insert_active_or_bootstrap`
    // now admits exactly two cases — a row in the ACTIVE workspace (the invite
    // path) and a row in the workspace being bootstrapped.
    //
    // So the assertion moves to the case that is still refused, and is the one
    // that actually matters: tenant A, operating legitimately inside its OWN
    // workspace, cannot write a membership into tenant B's. Note the GUC binds
    // workspace A here — the old test bound B, which is now indistinguishable
    // from an admin of B adding a member, and is exactly what the invite path is.
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.workspaceMembership.create({
          data: { userId: fx.userAId, workspaceId: fx.workspaceBId, role: 'member' },
        }),
      ),
    ).rejects.toMatchObject({
      // The pg DriverAdapterError carries the raw Postgres SQLSTATE on
      // `cause.code` (42501 = insufficient_privilege, the RLS denial).
      cause: { code: '42501' },
    });

    // Sanity: no cross-tenant membership leaked in — read through the ADMIN
    // client, so an ABSENT row and a row merely HIDDEN from A are not the same
    // observation.
    const leaked = await adminDb.workspaceMembership.findFirst({
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

    // Sanity: B's workspace name is untouched — read through the ADMIN client,
    // because the claim is about the ROW rather than about A's visibility.
    const b = await adminDb.workspace.findUnique({ where: { id: fx.workspaceBId } });
    expect(b?.name).toBe('Workspace B');
  });
});

describe('multi-tenant — FK cascade (independent of RLS)', () => {
  // Cascades are FK-level and apply regardless of role, so these run through
  // the ADMIN client — a tenant-scoped count with nothing bound would read zero
  // for a reason unrelated to the cascade. They back the hard-delete contract: deleting a
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
    const seeded = await adminDb.workspaceMembership.count({
      where: { workspaceId: workspace.id },
    });
    expect(seeded).toBe(1);

    await adminDb.workspace.delete({ where: { id: workspace.id } });

    const deleted = await adminDb.workspace.findUnique({ where: { id: workspace.id } });
    expect(deleted).toBeNull();
    const remaining = await adminDb.workspaceMembership.count({
      where: { workspaceId: workspace.id },
    });
    expect(remaining).toBe(0);
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
    const seeded = await adminDb.workspaceMembership.count({ where: { userId: userA.id } });
    expect(seeded).toBe(1);

    await adminDb.user.delete({ where: { id: userA.id } });

    const remaining = await adminDb.workspaceMembership.count({ where: { userId: userA.id } });
    expect(remaining).toBe(0);
    // The workspace itself survives (only the membership cascaded).
    const survivor = await adminDb.workspace.findUnique({ where: { id: workspace.id } });
    expect(survivor).not.toBeNull();
  });
});
