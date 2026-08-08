import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// `ci_period_charge` isolation — direct-DB RLS proof (Story MOTIR-1775 ·
// MOTIR-1901). What an org has been CHARGED is commercially sensitive in the
// same way its consumption is: it says how much a tenant builds, how often, and
// what it costs them. A tenant reading another's would be a real leak.
//
// ⚠️ THE POLICY UNDER TEST IS ORG-SCOPED, not workspace-scoped — the one place
// this table departs from its two metering siblings
// (`ci_workflow_run_usage` / `ci_period_usage`, whose isolation is proved in
// `ci-minutes-meter-rls.test.ts`). The pool and the credit ledger are both
// org-level (`ci-minutes-allowance.md` §4.1), so a charge spanning an org's
// workspaces has no single workspace to gate on. Hence
// `system_admin OR organization_id = app.organization_id`, the `organization` /
// `organization_membership` shape, plus the system escape the webhook-driven
// charger needs (it has no session, no active workspace and no active org).
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE ROW
// LEVEL SECURITY. Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE prodect_app`. WITHOUT the role switch each assertion would
// assert the OPPOSITE of reality.

const PERIOD = new Date('2026-07-01T00:00:00.000Z');

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface ChargeTenantFixture {
  userAId: string;
  userBId: string;
  workspaceAId: string;
  orgAId: string;
  orgBId: string;
  chargeAId: string;
  chargeBId: string;
}

async function makeChargeTenants(): Promise<ChargeTenantFixture> {
  const userA = await usersService.createUser({
    email: 'ci-charge-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Charge Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'ci-charge-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Charge Tenant B',
  });
  const { workspace: wsA } = await workspacesService.createWorkspace({
    name: 'Tenant A',
    ownerUserId: userA.id,
  });
  const { workspace: wsB } = await workspacesService.createWorkspace({
    name: 'Tenant B',
    ownerUserId: userB.id,
  });

  const chargeA = await db.ciPeriodCharge.create({
    data: {
      organizationId: wsA.organizationId,
      periodStart: PERIOD,
      accountedMinutes: new Prisma.Decimal(1500),
      chargedMinutes: new Prisma.Decimal(500),
      chargedCredits: 500,
      debitedCredits: 500,
    },
  });
  const chargeB = await db.ciPeriodCharge.create({
    data: {
      organizationId: wsB.organizationId,
      periodStart: PERIOD,
      accountedMinutes: new Prisma.Decimal(2000),
      chargedMinutes: new Prisma.Decimal(1000),
      chargedCredits: 1000,
      debitedCredits: 1000,
    },
  });

  return {
    userAId: userA.id,
    userBId: userB.id,
    workspaceAId: wsA.id,
    orgAId: wsA.organizationId,
    orgBId: wsB.organizationId,
    chargeAId: chargeA.id,
    chargeBId: chargeB.id,
  };
}

async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; organizationId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.organizationId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    }
    if (ctx.systemAdmin === true) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('ci_period_charge RLS — read isolation', () => {
  it('with NO GUC set, the prodect_app role sees zero charge rows', async () => {
    await makeChargeTenants();
    expect(await asAppRole({}, (tx) => tx.ciPeriodCharge.findMany())).toEqual([]);
  });

  it("with org-A's GUC bound, only A's charge is visible — never B's", async () => {
    const fx = await makeChargeTenants();
    const rows = await asAppRole({ organizationId: fx.orgAId }, (tx) =>
      tx.ciPeriodCharge.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.chargeAId]);
    expect(rows[0]?.chargedCredits).toBe(500);
  });

  it("tenant A cannot SELECT tenant B's charge by id", async () => {
    const fx = await makeChargeTenants();
    expect(
      await asAppRole({ organizationId: fx.orgAId }, (tx) =>
        tx.ciPeriodCharge.findUnique({ where: { id: fx.chargeBId } }),
      ),
    ).toBeNull();
  });

  it('a WORKSPACE GUC alone does NOT admit the row — the gate is the ORG', async () => {
    // The load-bearing difference from the two metering tables. Binding only
    // `app.workspace_id` (what a workspace-scoped request path binds) must not
    // reveal a charge row, or the org gate would be decorative.
    const fx = await makeChargeTenants();
    expect(
      await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciPeriodCharge.findMany(),
      ),
    ).toEqual([]);
  });

  it('the system escape sees every org — the charger writes without a session', async () => {
    await makeChargeTenants();
    const rows = await asAppRole({ systemAdmin: true }, (tx) => tx.ciPeriodCharge.findMany());
    expect(rows).toHaveLength(2);
  });
});

describe('ci_period_charge RLS — write isolation', () => {
  it("tenant A cannot UPDATE tenant B's charge", async () => {
    const fx = await makeChargeTenants();
    const updated = await asAppRole({ organizationId: fx.orgAId }, (tx) =>
      tx.ciPeriodCharge.updateMany({
        where: { id: fx.chargeBId },
        data: { chargedCredits: 0 },
      }),
    );
    expect(updated.count).toBe(0);

    const untouched = await db.ciPeriodCharge.findUniqueOrThrow({ where: { id: fx.chargeBId } });
    expect(untouched.chargedCredits).toBe(1000);
  });

  it("tenant A cannot INSERT a charge row for tenant B's org (WITH CHECK)", async () => {
    const fx = await makeChargeTenants();
    await expect(
      asAppRole({ organizationId: fx.orgAId }, (tx) =>
        tx.ciPeriodCharge.create({
          data: {
            organizationId: fx.orgBId,
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            chargedCredits: 999,
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("tenant A cannot DELETE tenant B's charge", async () => {
    const fx = await makeChargeTenants();
    const deleted = await asAppRole({ organizationId: fx.orgAId }, (tx) =>
      tx.ciPeriodCharge.deleteMany({ where: { id: fx.chargeBId } }),
    );
    expect(deleted.count).toBe(0);
    expect(await db.ciPeriodCharge.count()).toBe(2);
  });
});
