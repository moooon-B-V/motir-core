import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withOrgContext } from '@/lib/organizations/context';
import { createTestUser } from './fixtures/userFixtures';
import { truncateAuthTables } from './helpers/db';

// RLS verification suite for the org tier (Story 6.10 · Subtask 6.10.7 — the
// migration's RLS-policy half of the exhaustive matrix). Two layers, mirroring
// workspace-rls.test.ts:
//   1. The withOrgContext runtime helper opens a $transaction and pins the
//      app.user_id + app.organization_id GUCs for every query routed through tx.
//   2. The migration's policies actually deny cross-tenant rows when the
//      Postgres role can't bypass RLS.
//
// (2) needs the role-switch dance: the dev container's `prodect` role is a
// superuser and bypasses RLS even under FORCE. We `SET LOCAL ROLE prodect_app`
// (the non-bypass role from add_workspace_rls) inside a transaction; the role
// reverts at txn end. The org tier is a TENANT-ROOT pair (organization /
// organization_membership), so its policies admit "the active-org GUC OR a row
// the user is a member of / owns" — the same shape as workspace /
// workspace_membership.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface OrgRlsFixture {
  userAId: string;
  memberBId: string;
  strangerId: string;
  orgAId: string;
  orgSId: string;
}

// orgA: owned by userA, with memberB as a plain member. orgS: owned by a
// stranger (userA is in neither role). Both orgs are minted by createWorkspace
// (which founds a default org + owner membership).
async function makeFixture(): Promise<OrgRlsFixture> {
  const userA = await createTestUser({ name: 'User A' });
  const memberB = await createTestUser({ name: 'Member B' });
  const stranger = await createTestUser({ name: 'Stranger' });

  const { workspace: wsA } = await workspacesService.createWorkspace({
    name: 'Workspace A',
    ownerUserId: userA.id,
  });
  const orgAId = (await db.workspace.findUniqueOrThrow({ where: { id: wsA.id } })).organizationId;
  await organizationsService.addMember({
    organizationId: orgAId,
    userId: memberB.id,
    role: 'member',
    actorUserId: userA.id,
  });

  const { workspace: wsS } = await workspacesService.createWorkspace({
    name: 'Stranger Workspace',
    ownerUserId: stranger.id,
  });
  const orgSId = (await db.workspace.findUniqueOrThrow({ where: { id: wsS.id } })).organizationId;

  return { userAId: userA.id, memberBId: memberB.id, strangerId: stranger.id, orgAId, orgSId };
}

/**
 * Run `fn` inside a transaction that (a) optionally pins the org + user GUCs and
 * (b) drops to the non-bypass `prodect_app` role for the duration. The
 * role-switch is what exercises RLS — without it the superuser default bypasses
 * the policies even under FORCE ROW LEVEL SECURITY. Mirrors workspace-rls's
 * asAppRole, but binds the org-tier GUCs.
 */
async function asAppRole<T>(
  ctx: { userId?: string; organizationId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.organizationId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('organization RLS — visibility', () => {
  it('with no GUC set, the prodect_app role sees zero organization rows', async () => {
    await makeFixture();
    const rows = await asAppRole({}, (tx) => tx.organization.findMany());
    expect(rows).toEqual([]);
  });

  it('with only the user GUC, the orgs the user is a member of are visible (and a stranger org is not)', async () => {
    const fx = await makeFixture();
    const rows = await asAppRole({ userId: fx.userAId }, (tx) => tx.organization.findMany());
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([fx.orgAId]); // member of orgA only
    expect(ids).not.toContain(fx.orgSId);
  });

  it('with the active-org GUC, that org is visible (the active-org branch)', async () => {
    const fx = await makeFixture();
    // memberB is a member of orgA; with orgA active they see it via either branch.
    const rows = await asAppRole({ userId: fx.memberBId, organizationId: fx.orgAId }, (tx) =>
      tx.organization.findMany({ where: { id: fx.orgAId } }),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.orgAId]);
  });

  it('without any GUC, a member cannot SELECT their org by id', async () => {
    const fx = await makeFixture();
    const rows = await asAppRole({}, (tx) =>
      tx.organization.findMany({ where: { id: fx.orgAId } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('organization RLS — mutation', () => {
  it('UPDATE on a non-active org fails with P2025 (the mutate policy gates on the active-org GUC)', async () => {
    const fx = await makeFixture();
    await expect(
      asAppRole({ userId: fx.userAId, organizationId: fx.orgAId }, (tx) =>
        tx.organization.update({ where: { id: fx.orgSId }, data: { name: 'Hijacked' } }),
      ),
    ).rejects.toMatchObject({
      // RLS hides the stranger org from the UPDATE → zero rows matched → P2025.
      code: 'P2025',
    });
    // Sanity: the stranger org's name is unchanged.
    const stranger = await db.organization.findUnique({ where: { id: fx.orgSId } });
    expect(stranger?.name).toBe('Stranger Workspace');
  });

  it('UPDATE on the active org succeeds (the rename path the service uses)', async () => {
    const fx = await makeFixture();
    const updated = await asAppRole({ userId: fx.userAId, organizationId: fx.orgAId }, (tx) =>
      tx.organization.update({ where: { id: fx.orgAId }, data: { name: 'Acme Renamed' } }),
    );
    expect(updated.name).toBe('Acme Renamed');
  });
});

describe('organization_membership RLS', () => {
  it('with no GUC, zero membership rows are visible', async () => {
    await makeFixture();
    const rows = await asAppRole({}, (tx) => tx.organizationMembership.findMany());
    expect(rows).toEqual([]);
  });

  it("with only the user GUC, the user's own membership rows are visible (and not others')", async () => {
    const fx = await makeFixture();
    const rows = await asAppRole({ userId: fx.memberBId }, (tx) =>
      tx.organizationMembership.findMany(),
    );
    expect(rows.map((r) => r.userId)).toEqual([fx.memberBId]);
    expect(rows.every((r) => r.organizationId === fx.orgAId)).toBe(true);
  });

  it("with the active-org GUC, ALL members' rows for that org are visible (the roster read path)", async () => {
    const fx = await makeFixture();
    const rows = await asAppRole({ userId: fx.userAId, organizationId: fx.orgAId }, (tx) =>
      tx.organizationMembership.findMany({ where: { organizationId: fx.orgAId } }),
    );
    // Both the owner (userA) and the plain member (memberB) are visible.
    expect(rows.map((r) => r.userId).sort()).toEqual([fx.userAId, fx.memberBId].sort());
  });

  it('a user can DELETE their own membership with only the user GUC (the self-leave branch)', async () => {
    const fx = await makeFixture();
    const deleted = await asAppRole({ userId: fx.memberBId }, (tx) =>
      tx.organizationMembership.deleteMany({
        where: { organizationId: fx.orgAId, userId: fx.memberBId },
      }),
    );
    expect(deleted.count).toBe(1);
    // The row is really gone (verified as the bypass role).
    expect(
      await db.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId: fx.orgAId, userId: fx.memberBId } },
      }),
    ).toBeNull();
  });

  it("a user CANNOT delete another user's membership without the active-org GUC", async () => {
    const fx = await makeFixture();
    // memberB tries to remove the owner (userA) with only their own user GUC —
    // neither the active-org branch nor the self branch admits it, so zero rows.
    const deleted = await asAppRole({ userId: fx.memberBId }, (tx) =>
      tx.organizationMembership.deleteMany({
        where: { organizationId: fx.orgAId, userId: fx.userAId },
      }),
    );
    expect(deleted.count).toBe(0);
    expect(
      await db.organizationMembership.findUnique({
        where: { organizationId_userId: { organizationId: fx.orgAId, userId: fx.userAId } },
      }),
    ).not.toBeNull();
  });
});

describe('withOrgContext', () => {
  // Runs as the default `prodect` (superuser) role, which bypasses RLS. The
  // point is to prove the helper pins both GUCs and they persist across queries
  // in the callback (the load-bearing reason for $transaction) and are
  // discarded after — the RLS-enforcement tests above already prove the
  // policies bite under the non-bypass role.
  it('pins both GUCs and they persist across queries in the callback', async () => {
    const fx = await makeFixture();
    const [seenUser, seenOrg] = await withOrgContext(
      { userId: fx.userAId, organizationId: fx.orgAId },
      async (tx) => {
        const u = await tx.$queryRaw<
          { setting: string | null }[]
        >`SELECT current_setting('app.user_id', true) AS setting`;
        const o = await tx.$queryRaw<
          { setting: string | null }[]
        >`SELECT current_setting('app.organization_id', true) AS setting`;
        return [u[0]?.setting ?? null, o[0]?.setting ?? null];
      },
    );
    expect(seenUser).toBe(fx.userAId);
    expect(seenOrg).toBe(fx.orgAId);
  });

  it('discards the GUC after the transaction ends', async () => {
    const fx = await makeFixture();
    await withOrgContext({ userId: fx.userAId, organizationId: fx.orgAId }, async () => {
      // no-op
    });
    const rows = await db.$queryRaw<
      { setting: string | null }[]
    >`SELECT current_setting('app.organization_id', true) AS setting`;
    expect(rows[0]?.setting ?? null).toBeFalsy();
  });
});
