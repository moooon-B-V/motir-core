import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// `ci_container_usage` + `ci_container_period_cost` isolation — direct-DB RLS
// proof (Story MOTIR-1916 · MOTIR-1924), the tenancy half of this card's
// acceptance and the same shape `ci-minutes-meter-rls.test.ts` proves one meter
// over.
//
// What the fleet cost Motir per tenant is commercially sensitive in BOTH
// directions: a row says how much a tenant builds, and what serving them costs.
// One tenant reading another's would be a real leak, not a curiosity.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE ROW
// LEVEL SECURITY. Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE prodect_app`. WITHOUT the role switch each assertion would
// assert the OPPOSITE of reality. `asAppRole` is a local copy of the helper in
// ci-minutes-meter-rls.test.ts, for the reason that file gives.
//
// The policies under test (20260802130157_add_ci_container_usage): one PERMISSIVE
// `FOR ALL` policy per table, `system_admin OR workspace_id = app.workspace_id`
// on both USING and WITH CHECK — the escape hatch is not optional here, because
// the ONLY writer is the fleet orchestrator's background job, which has no
// session and no active workspace.

const PERIOD = new Date('2026-08-01T00:00:00.000Z');
const STOPPED_AT = new Date('2026-08-15T12:00:00.000Z');

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface FleetTenantFixture {
  userAId: string;
  userBId: string;
  workspaceAId: string;
  workspaceBId: string;
  orgAId: string;
  orgBId: string;
  usageAId: string;
  usageBId: string;
  costAId: string;
  costBId: string;
}

async function makeFleetTenants(): Promise<FleetTenantFixture> {
  const userA = await usersService.createUser({
    email: 'fleet-cost-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Fleet Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'fleet-cost-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Fleet Tenant B',
  });
  const a = await workspacesService.createWorkspace({ name: 'Fleet WS A', ownerUserId: userA.id });
  const b = await workspacesService.createWorkspace({ name: 'Fleet WS B', ownerUserId: userB.id });

  const usageA = await db.ciContainerUsage.create({
    data: {
      containerProvider: 'fly',
      handleId: 'machine-a',
      containerRegion: 'iad',
      workspaceId: a.workspace.id,
      organizationId: a.workspace.organizationId,
      repoFullName: 'motir-projects/alpha-web',
      workflowJobId: '44001',
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 8192,
      containerCreatedAt: STOPPED_AT,
      containerStartedAt: STOPPED_AT,
      containerStoppedAt: STOPPED_AT,
      billableSeconds: 240,
      periodStart: PERIOD,
      usdPerSecond: new Prisma.Decimal('0.000031636049'),
      costUsd: new Prisma.Decimal('0.007592651760'),
      rateEffectiveFrom: PERIOD,
      terminalState: 'destroyed',
      teardownReason: 'job_completed',
    },
  });
  const usageB = await db.ciContainerUsage.create({
    data: {
      containerProvider: 'fly',
      handleId: 'machine-b',
      containerRegion: 'iad',
      workspaceId: b.workspace.id,
      organizationId: b.workspace.organizationId,
      repoFullName: 'motir-projects/bravo-web',
      workflowJobId: '44002',
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 8192,
      containerCreatedAt: STOPPED_AT,
      containerStartedAt: STOPPED_AT,
      containerStoppedAt: STOPPED_AT,
      billableSeconds: 600,
      periodStart: PERIOD,
      usdPerSecond: new Prisma.Decimal('0.000031636049'),
      costUsd: new Prisma.Decimal('0.018981629400'),
      rateEffectiveFrom: PERIOD,
      terminalState: 'destroyed',
      teardownReason: 'job_completed',
    },
  });
  const costA = await db.ciContainerPeriodCost.create({
    data: {
      workspaceId: a.workspace.id,
      organizationId: a.workspace.organizationId,
      periodStart: PERIOD,
      containerSeconds: 240,
      costUsd: new Prisma.Decimal('0.007592651760'),
      containerCount: 1,
    },
  });
  const costB = await db.ciContainerPeriodCost.create({
    data: {
      workspaceId: b.workspace.id,
      organizationId: b.workspace.organizationId,
      periodStart: PERIOD,
      containerSeconds: 600,
      costUsd: new Prisma.Decimal('0.018981629400'),
      containerCount: 1,
    },
  });

  return {
    userAId: userA.id,
    userBId: userB.id,
    workspaceAId: a.workspace.id,
    workspaceBId: b.workspace.id,
    orgAId: a.workspace.organizationId,
    orgBId: b.workspace.organizationId,
    usageAId: usageA.id,
    usageBId: usageB.id,
    costAId: costA.id,
    costBId: costB.id,
  };
}

/** Run `fn` with the given GUCs bound, as the non-bypass `prodect_app` role —
 *  the role switch is what makes RLS actually bite. Reverts at txn end. */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.systemAdmin === true) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

describe('ci_container_usage RLS — read isolation', () => {
  it('with NO GUC set, the prodect_app role sees zero container rows', async () => {
    await makeFleetTenants();
    expect(await asAppRole({}, (tx) => tx.ciContainerUsage.findMany())).toEqual([]);
  });

  it("with workspace-A's GUC bound, only A's container is visible — never B's", async () => {
    const fx = await makeFleetTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.ciContainerUsage.findMany(),
    );
    expect(rows.map((r) => r.handleId)).toEqual(['machine-a']);
  });

  it("knowing B's ORGANIZATION id buys tenant A nothing", async () => {
    // `organization_id` is denormalized here so the margin read is one indexed
    // query — but the gate is the row's OWN workspace_id, and RLS does not
    // traverse foreign keys. The extra column widens the INDEX, never access.
    const fx = await makeFleetTenants();
    expect(
      await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciContainerUsage.findMany({ where: { organizationId: fx.orgBId } }),
      ),
    ).toEqual([]);
  });

  it("the cross-tenant owner SUM cannot be used to read another tenant's spend", async () => {
    // The fleet reconciliation's read is raw SQL over EVERY tenant's rows, so it
    // is worth proving the policy applies to `$queryRaw` and not only to the
    // Prisma delegates — otherwise a tenant could learn a competitor's build
    // volume, and Motir's cost of serving them, through an aggregate.
    const fx = await makeFleetTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceAId },
      (tx) =>
        tx.$queryRaw<Array<{ seconds: bigint | number }>>`
        SELECT COALESCE(SUM("billable_seconds"), 0) AS "seconds"
        FROM "ci_container_usage"
        WHERE LOWER(split_part("repo_full_name", '/', 1)) = 'motir-projects'
      `,
    );
    // A's own 240 seconds, and none of B's 600.
    expect(Number(rows[0]?.seconds)).toBe(240);
  });

  it('the SYSTEM ADMIN escape sees every tenant — the orchestrator has no workspace', async () => {
    const fx = await makeFleetTenants();
    const rows = await asAppRole({ systemAdmin: true }, (tx) => tx.ciContainerUsage.findMany());
    expect(rows.map((r) => r.handleId).sort()).toEqual(['machine-a', 'machine-b']);
    expect(fx.usageAId).toBeDefined();
  });
});

describe('ci_container_usage RLS — write isolation', () => {
  it('tenant A cannot INSERT a row tenanted to B (WITH CHECK)', async () => {
    const fx = await makeFleetTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciContainerUsage.create({
          data: {
            containerProvider: 'fly',
            handleId: 'machine-smuggled',
            containerRegion: 'iad',
            workspaceId: fx.workspaceBId,
            organizationId: fx.orgBId,
            repoFullName: 'motir-projects/bravo-web',
            workflowJobId: '44003',
            cpuKind: 'performance',
            cpus: 2,
            memoryMb: 8192,
            containerCreatedAt: STOPPED_AT,
            containerStartedAt: STOPPED_AT,
            containerStoppedAt: STOPPED_AT,
            billableSeconds: 10,
            periodStart: PERIOD,
            usdPerSecond: new Prisma.Decimal('0.000031636049'),
            costUsd: new Prisma.Decimal('0.000316360490'),
            rateEffectiveFrom: PERIOD,
            terminalState: 'destroyed',
            teardownReason: 'job_completed',
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it("tenant A cannot UPDATE tenant B's row", async () => {
    const fx = await makeFleetTenants();
    const { count } = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.ciContainerUsage.updateMany({
        where: { id: fx.usageBId },
        data: { billableSeconds: 1 },
      }),
    );
    expect(count).toBe(0);
    const untouched = await db.ciContainerUsage.findUniqueOrThrow({ where: { id: fx.usageBId } });
    expect(untouched.billableSeconds).toBe(600);
  });
});

describe('ci_container_period_cost RLS', () => {
  it("with workspace-A's GUC bound, only A's rollup is visible", async () => {
    const fx = await makeFleetTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.ciContainerPeriodCost.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.costAId]);
  });

  it("tenant A cannot read tenant B's rollup by id", async () => {
    const fx = await makeFleetTenants();
    expect(
      await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciContainerPeriodCost.findMany({ where: { id: fx.costBId } }),
      ),
    ).toEqual([]);
  });

  it('the SYSTEM ADMIN escape can write the rollup — the orchestrator path', async () => {
    const fx = await makeFleetTenants();
    const { count } = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.ciContainerPeriodCost.updateMany({
        where: { id: fx.costBId },
        data: { containerCount: 2 },
      }),
    );
    expect(count).toBe(1);
  });
});
