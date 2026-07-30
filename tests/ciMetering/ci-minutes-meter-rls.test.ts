import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { truncateAuthTables } from '../helpers/db';

// `ci_workflow_run_usage` + `ci_period_usage` isolation — direct-DB RLS proof
// (Story MOTIR-1775 · MOTIR-1896), this card's tenancy acceptance: "the new
// table carries workspace_id + RLS, with a cross-tenant isolation test."
//
// Consumption data is commercially sensitive — it says how much a tenant builds,
// how often, and what it costs — so a tenant reading another's would be a real
// leak, not a curiosity.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is inert under it regardless of FORCE ROW
// LEVEL SECURITY. Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE prodect_app`. WITHOUT the role switch each assertion would
// assert the OPPOSITE of reality. `asAppRole` is a local copy of the helper in
// project-repo-rls.test.ts / project-rls.test.ts, for the reason those files give.
//
// The policies under test (20260730203000_add_ci_minutes_meter): one PERMISSIVE
// `FOR ALL` policy per table, `system_admin OR workspace_id = app.workspace_id`
// on both USING and WITH CHECK — the `github_repo` shape rather than
// `project_repository`'s pure workspace gate, because the WRITER here is the
// `workflow_run` webhook, which has no session and no active workspace.

const PERIOD = new Date('2026-07-01T00:00:00.000Z');

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface MeterTenantFixture {
  userAId: string;
  userBId: string;
  workspaceAId: string;
  workspaceBId: string;
  orgAId: string;
  orgBId: string;
  runAId: string;
  runBId: string;
  periodAId: string;
  periodBId: string;
}

async function makeMeterTenants(): Promise<MeterTenantFixture> {
  const userA = await usersService.createUser({
    email: 'ci-meter-tenant-a@example.com',
    password: 'hunter2hunter2',
    name: 'Meter Tenant A',
  });
  const userB = await usersService.createUser({
    email: 'ci-meter-tenant-b@example.com',
    password: 'hunter2hunter2',
    name: 'Meter Tenant B',
  });
  const a = await workspacesService.createWorkspace({ name: 'Meter WS A', ownerUserId: userA.id });
  const b = await workspacesService.createWorkspace({ name: 'Meter WS B', ownerUserId: userB.id });

  const runA = await db.ciWorkflowRunUsage.create({
    data: {
      workspaceId: a.workspace.id,
      organizationId: a.workspace.organizationId,
      runId: 'run-a',
      runAttempt: 1,
      repoOwner: 'motir-projects',
      repoName: 'alpha-web',
      periodStart: PERIOD,
      runCompletedAt: new Date('2026-07-30T12:00:00.000Z'),
      billableMinutes: 19,
      rawWallClockSeconds: new Prisma.Decimal(1140),
      linearEquivalentMinutes: new Prisma.Decimal(19),
      jobCount: 4,
      runnerBreakdown: [],
    },
  });
  const runB = await db.ciWorkflowRunUsage.create({
    data: {
      workspaceId: b.workspace.id,
      organizationId: b.workspace.organizationId,
      runId: 'run-b',
      runAttempt: 1,
      repoOwner: 'motir-projects',
      repoName: 'bravo-web',
      periodStart: PERIOD,
      runCompletedAt: new Date('2026-07-30T12:00:00.000Z'),
      billableMinutes: 40,
      rawWallClockSeconds: new Prisma.Decimal(2400),
      linearEquivalentMinutes: new Prisma.Decimal(40),
      jobCount: 4,
      runnerBreakdown: [],
    },
  });
  const periodA = await db.ciPeriodUsage.create({
    data: {
      workspaceId: a.workspace.id,
      organizationId: a.workspace.organizationId,
      periodStart: PERIOD,
      billableMinutes: 19,
      rawWallClockSeconds: new Prisma.Decimal(1140),
      linearEquivalentMinutes: new Prisma.Decimal(19),
      runCount: 1,
    },
  });
  const periodB = await db.ciPeriodUsage.create({
    data: {
      workspaceId: b.workspace.id,
      organizationId: b.workspace.organizationId,
      periodStart: PERIOD,
      billableMinutes: 40,
      rawWallClockSeconds: new Prisma.Decimal(2400),
      linearEquivalentMinutes: new Prisma.Decimal(40),
      runCount: 1,
    },
  });

  return {
    userAId: userA.id,
    userBId: userB.id,
    workspaceAId: a.workspace.id,
    workspaceBId: b.workspace.id,
    orgAId: a.workspace.organizationId,
    orgBId: b.workspace.organizationId,
    runAId: runA.id,
    runBId: runB.id,
    periodAId: periodA.id,
    periodBId: periodB.id,
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

describe('ci_workflow_run_usage RLS — read isolation', () => {
  it('with NO GUC set, the prodect_app role sees zero metered runs', async () => {
    await makeMeterTenants();
    expect(await asAppRole({}, (tx) => tx.ciWorkflowRunUsage.findMany())).toEqual([]);
  });

  it("with workspace-A's GUC bound, only A's run is visible — never B's", async () => {
    const fx = await makeMeterTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.ciWorkflowRunUsage.findMany(),
    );
    expect(rows.map((r) => r.runId)).toEqual(['run-a']);
  });

  it("tenant A cannot SELECT tenant B's run by id", async () => {
    const fx = await makeMeterTenants();
    expect(
      await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciWorkflowRunUsage.findMany({ where: { id: fx.runBId } }),
      ),
    ).toEqual([]);
  });

  it("knowing B's ORGANIZATION id buys tenant A nothing", async () => {
    // `organization_id` is denormalized onto these tables so the allowance
    // sibling's read is one indexed query — but the RLS gate is the row's OWN
    // workspace_id, and RLS does not traverse foreign keys. So the extra column
    // widens the INDEX, never the access.
    const fx = await makeMeterTenants();
    expect(
      await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciWorkflowRunUsage.findMany({ where: { organizationId: fx.orgBId } }),
      ),
    ).toEqual([]);
  });

  it("the org-period SUM cannot be used to read another tenant's totals", async () => {
    // The aggregate is the one read MOTIR-1901 consumes, so it is worth proving
    // the policy applies to the raw SQL and not only to the Prisma delegates —
    // otherwise a tenant could learn a competitor's build volume via a SUM.
    const fx = await makeMeterTenants();
    const rows = await asAppRole(
      { userId: fx.userAId, workspaceId: fx.workspaceAId },
      (tx) => tx.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
        SELECT COALESCE(SUM("linear_equivalent_minutes"), 0) AS "total"
        FROM "ci_period_usage"
        WHERE "organization_id" = ${fx.orgBId} AND "period_start" = ${PERIOD}
      `,
    );
    expect(Number(rows[0]?.total ?? 0)).toBe(0);
  });

  it('the system-admin hatch DOES span tenants — the webhook writer needs it', async () => {
    // The deliberate difference from `project_repository`'s pure workspace gate:
    // the meter's writer is a webhook with no active workspace, so without this
    // branch it could not write its own rows at all.
    await makeMeterTenants();
    const rows = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.ciWorkflowRunUsage.findMany({ orderBy: { runId: 'asc' } }),
    );
    expect(rows.map((r) => r.runId)).toEqual(['run-a', 'run-b']);
  });
});

describe('ci_period_usage RLS — read isolation', () => {
  it('with NO GUC set, the prodect_app role sees zero rollups', async () => {
    await makeMeterTenants();
    expect(await asAppRole({}, (tx) => tx.ciPeriodUsage.findMany())).toEqual([]);
  });

  it("with workspace-A's GUC bound, only A's rollup is visible", async () => {
    const fx = await makeMeterTenants();
    const rows = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.ciPeriodUsage.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([fx.periodAId]);
    expect(rows.map((r) => r.billableMinutes)).toEqual([19]);
  });
});

describe('ci_workflow_run_usage RLS — write isolation', () => {
  it('UPDATE of a row outside the active workspace affects zero rows (P2025)', async () => {
    const fx = await makeMeterTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciWorkflowRunUsage.update({
          where: { id: fx.runBId },
          data: { billableMinutes: 0 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2025' });

    const b = await db.ciWorkflowRunUsage.findUnique({ where: { id: fx.runBId } });
    expect(b?.billableMinutes).toBe(40);
  });

  it('DELETE of a row outside the active workspace removes nothing', async () => {
    const fx = await makeMeterTenants();
    const deleted = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.ciWorkflowRunUsage.deleteMany({ where: { id: fx.runBId } }),
    );
    expect(deleted.count).toBe(0);
    expect(await db.ciWorkflowRunUsage.findUnique({ where: { id: fx.runBId } })).not.toBeNull();
  });

  it('INSERT with a workspace_id not matching the active GUC is denied (42501)', async () => {
    // The interesting attack for a METER: charging your own consumption to
    // another tenant. WITH CHECK refuses it.
    const fx = await makeMeterTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciWorkflowRunUsage.create({
          data: {
            workspaceId: fx.workspaceBId,
            organizationId: fx.orgBId,
            runId: 'smuggled',
            runAttempt: 1,
            repoOwner: 'motir-projects',
            repoName: 'smuggled',
            periodStart: PERIOD,
            runCompletedAt: new Date('2026-07-30T12:00:00.000Z'),
            billableMinutes: 500,
            rawWallClockSeconds: new Prisma.Decimal(30000),
            linearEquivalentMinutes: new Prisma.Decimal(500),
            jobCount: 1,
            runnerBreakdown: [],
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    expect(await db.ciWorkflowRunUsage.findFirst({ where: { runId: 'smuggled' } })).toBeNull();
  });

  it('a tenant cannot MOVE its own metered run into another workspace', async () => {
    // The re-tenanting attack: USING passes on the OLD row, but the NEW row must
    // also satisfy WITH CHECK — so offloading your spend onto a neighbour fails.
    const fx = await makeMeterTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciWorkflowRunUsage.update({
          where: { id: fx.runAId },
          data: { workspaceId: fx.workspaceBId },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    const a = await db.ciWorkflowRunUsage.findUnique({ where: { id: fx.runAId } });
    expect(a?.workspaceId).toBe(fx.workspaceAId);
  });
});

describe('ci_period_usage RLS — write isolation', () => {
  it('a tenant cannot shrink another tenant’s rollup', async () => {
    const fx = await makeMeterTenants();
    const updated = await asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
      tx.ciPeriodUsage.updateMany({
        where: { id: fx.periodBId },
        data: { billableMinutes: 0 },
      }),
    );
    expect(updated.count).toBe(0);
    const b = await db.ciPeriodUsage.findUnique({ where: { id: fx.periodBId } });
    expect(b?.billableMinutes).toBe(40);
  });

  it('INSERT of a rollup into another workspace is denied (42501)', async () => {
    const fx = await makeMeterTenants();
    await expect(
      asAppRole({ userId: fx.userAId, workspaceId: fx.workspaceAId }, (tx) =>
        tx.ciPeriodUsage.create({
          data: {
            workspaceId: fx.workspaceBId,
            organizationId: fx.orgBId,
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            billableMinutes: 1,
            rawWallClockSeconds: new Prisma.Decimal(60),
            linearEquivalentMinutes: new Prisma.Decimal(1),
            runCount: 1,
          },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
