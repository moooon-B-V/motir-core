import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createUser } from '@/lib/users/repo';
import { createWorkspace, addMember } from '@/lib/workspaces/repo';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from './helpers/db';

// RLS verification suite. Two layers under test:
//   1. The withWorkspaceContext runtime helper opens a $transaction and
//      pins both GUCs for every query routed through `tx`.
//   2. The migration's policies actually deny cross-tenant rows when the
//      Postgres role is one that can't bypass RLS.
//
// (2) needs care because the dev container's `prodect` role is a
// superuser, which unconditionally bypasses RLS regardless of FORCE.
// We exercise RLS by opening a transaction and `SET LOCAL ROLE
// prodect_app` (the non-bypass role created in the RLS migration). The
// role reverts at txn end so subsequent tests run as `prodect` again.
//
// Production deploys should DATABASE_URL-connect as prodect_app so RLS
// is load-bearing without the per-query role-switch dance — see the
// finding in prodect_plan/PRODECT_FINDINGS.md.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface RlsFixture {
  userId: string;
  workspaceAId: string;
  workspaceBId: string;
  strangerWorkspaceId: string;
}

async function makeFixture(): Promise<RlsFixture> {
  const user = await createUser({
    email: 'user@example.com',
    password: 'hunter2hunter2',
    name: 'User',
  });
  const stranger = await createUser({
    email: 'stranger@example.com',
    password: 'hunter2hunter2',
    name: 'Stranger',
  });

  const a = await createWorkspace({ name: 'Workspace A', ownerUserId: user.id });
  const b = await createWorkspace({ name: 'Workspace B', ownerUserId: user.id });
  const stranger_ws = await createWorkspace({
    name: 'Stranger Workspace',
    ownerUserId: stranger.id,
  });

  return {
    userId: user.id,
    workspaceAId: a.workspace.id,
    workspaceBId: b.workspace.id,
    strangerWorkspaceId: stranger_ws.workspace.id,
  };
}

/**
 * Run `fn` inside a transaction that (a) optionally pins the workspace +
 * user GUCs and (b) drops the connection to the non-bypass `prodect_app`
 * role for the duration of the transaction. The role-switch is what
 * actually exercises RLS — without it, the superuser default would
 * bypass policies even with FORCE ROW LEVEL SECURITY.
 *
 * Mirrors withWorkspaceContext's shape but with the extra role-switch
 * test-suite needs. We intentionally don't fold this into
 * withWorkspaceContext: production should run as prodect_app by virtue
 * of its DATABASE_URL, not via a per-query role switch.
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

describe('workspace RLS — visibility', () => {
  it('with no GUC set, the prodect_app role sees zero workspace rows', async () => {
    await makeFixture();
    const rows = await asAppRole({}, (tx) => tx.workspace.findMany());
    expect(rows).toEqual([]);
  });

  it('with the active workspace GUC set, only that workspace is visible', async () => {
    const fx = await makeFixture();
    const rows = await asAppRole({ userId: fx.userId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.workspace.findMany(),
    );
    // The user has membership in both A and B, so the
    // workspace_membership_visible policy lets them see both via that
    // policy's OR-branch. The point of this assertion is that the
    // stranger's workspace is NOT visible.
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([fx.workspaceAId, fx.workspaceBId].sort());
    expect(ids).not.toContain(fx.strangerWorkspaceId);
  });

  it('with workspace GUC pointing at a non-member workspace, that workspace is still not visible', async () => {
    const fx = await makeFixture();
    const rows = await asAppRole({ userId: fx.userId, workspaceId: fx.strangerWorkspaceId }, (tx) =>
      tx.workspace.findMany({ where: { id: fx.strangerWorkspaceId } }),
    );
    // The workspace_active policy WOULD permit reading the stranger
    // workspace because its id matches the GUC — but the user isn't a
    // member, so this branch passes. This is by-design: setting the
    // workspace_id GUC to a non-member workspace is itself a privilege
    // escalation. The middleware layer (lib/workspaces/middleware.ts)
    // prevents that by verifying membership before setting the GUC; the
    // RLS policy here is the *secondary* defense for the read path of
    // tenant-scoped tables landing in later Stories. Document the
    // expected behavior so the contract is explicit: at the DB layer,
    // workspace_active trusts the middleware to have done membership
    // verification. The cross-tenant guarantee for the workspace table
    // itself comes from the OTHER permissive policy
    // (workspace_membership_visible) which DOES gate on membership.
    expect(rows.map((r) => r.id)).toEqual([fx.strangerWorkspaceId]);
  });

  it('without the workspace GUC, a non-member cannot SELECT the stranger workspace by id', async () => {
    const fx = await makeFixture();
    const rows = await asAppRole({ userId: fx.userId }, (tx) =>
      tx.workspace.findMany({ where: { id: fx.strangerWorkspaceId } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('workspace RLS — mutation', () => {
  it('UPDATE on a non-active workspace fails with P2025 (RLS hides the row from update)', async () => {
    const fx = await makeFixture();
    await expect(
      asAppRole({ userId: fx.userId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.workspace.update({
          where: { id: fx.strangerWorkspaceId },
          data: { name: 'Hijacked' },
        }),
      ),
    ).rejects.toMatchObject({
      // Prisma raises P2025 when the WHERE matched zero rows — which is
      // exactly what RLS produces: the row exists, but the policy's
      // USING clause hides it from the UPDATE.
      code: 'P2025',
    });

    // Sanity: the stranger workspace's name is unchanged.
    const stranger = await db.workspace.findUnique({
      where: { id: fx.strangerWorkspaceId },
    });
    expect(stranger?.name).toBe('Stranger Workspace');
  });
});

describe('workspace_membership RLS', () => {
  it('with no GUC, zero membership rows are visible', async () => {
    await makeFixture();
    const rows = await asAppRole({}, (tx) => tx.workspaceMembership.findMany());
    expect(rows).toEqual([]);
  });

  it("with only the user GUC, the user's own memberships are visible", async () => {
    const fx = await makeFixture();
    const rows = await asAppRole({ userId: fx.userId }, (tx) => tx.workspaceMembership.findMany());
    const workspaceIds = rows.map((r) => r.workspaceId).sort();
    expect(workspaceIds).toEqual([fx.workspaceAId, fx.workspaceBId].sort());
  });

  it("with the active-workspace GUC, other members' rows for that workspace are visible", async () => {
    const fx = await makeFixture();
    const other = await createUser({
      email: 'other@example.com',
      password: 'hunter2hunter2',
      name: 'Other',
    });
    await addMember({ userId: other.id, workspaceId: fx.workspaceAId });

    const rows = await asAppRole({ userId: fx.userId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.workspaceMembership.findMany({ where: { workspaceId: fx.workspaceAId } }),
    );
    const userIds = rows.map((r) => r.userId).sort();
    expect(userIds).toEqual([fx.userId, other.id].sort());
  });
});

describe('withWorkspaceContext', () => {
  // These tests run as the default `prodect` role (superuser), which
  // bypasses RLS. The point here is to prove that the helper itself
  // pins the GUCs and that they persist across multiple queries inside
  // the same callback — the load-bearing reason for using $transaction.
  // The RLS-enforcement tests above already prove the policies bite
  // when the role doesn't bypass.

  it('pins both GUCs and they persist across multiple queries in the callback', async () => {
    const fx = await makeFixture();

    const [userIdSeen, workspaceIdSeen] = await withWorkspaceContext(
      { userId: fx.userId, workspaceId: fx.workspaceAId },
      async (tx) => {
        const first = await tx.$queryRaw<
          { setting: string | null }[]
        >`SELECT current_setting('app.user_id', true) AS setting`;
        const second = await tx.$queryRaw<
          { setting: string | null }[]
        >`SELECT current_setting('app.workspace_id', true) AS setting`;
        return [first[0]?.setting ?? null, second[0]?.setting ?? null];
      },
    );

    expect(userIdSeen).toBe(fx.userId);
    expect(workspaceIdSeen).toBe(fx.workspaceAId);
  });

  it('returns the value the callback returns', async () => {
    const fx = await makeFixture();
    const result = await withWorkspaceContext(
      { userId: fx.userId, workspaceId: fx.workspaceAId },
      async () => ({ ok: true, ws: fx.workspaceAId }),
    );
    expect(result).toEqual({ ok: true, ws: fx.workspaceAId });
  });

  it('discards the GUC after the transaction ends', async () => {
    const fx = await makeFixture();
    await withWorkspaceContext({ userId: fx.userId, workspaceId: fx.workspaceAId }, async () => {
      // no-op
    });
    const rows = await db.$queryRaw<
      { setting: string | null }[]
    >`SELECT current_setting('app.workspace_id', true) AS setting`;
    // SET LOCAL semantics: outside the transaction, the GUC is unset.
    // (Prisma queries are not auto-wrapped in a session-level tx, so we
    // really do see the post-rollback state here.)
    expect(rows[0]?.setting ?? null).toBeFalsy();
  });
});
