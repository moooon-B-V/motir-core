import { Prisma } from '@/lib/generated/prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  ciMinutesReconciliationService,
  reconcileFleetTotals,
  fleetToleranceFor,
  reconcileTotals,
} from '@/lib/services/ciMinutesReconciliationService';
import { MOTIR_FLEET_RUNNER_FAMILY } from '@/lib/ciMetering/runnerRates';
import { truncateAuthTables } from '../helpers/db';

// THE CORRECTED RECONCILIATION (Story MOTIR-1916 · MOTIR-1924) —
// `docs/decisions/ci-minutes-allowance.md` §Q.
//
// §5.8's audit compares the meter against GitHub's enhanced-billing usage
// endpoint, which reports what GITHUB BILLED. Once project CI runs on Motir's
// own fleet that report goes to ~0 for a fleet repo while the meter keeps
// counting a full month, so the audit would flag every repo every month at
// ~100% drift — worse than no audit, because it trains everyone to ignore the
// one signal that would catch a real metering bug.
//
// So the population is SPLIT by the runner family already stored on every
// metered row, and each half is audited against the source that knows about it.
// The tests below are, in order: the split itself (the mixed-row fixture the
// card's acceptance names), the fleet audit against the container record, and
// the proof that narrowing did not disable — a genuine mismatch still reports.

const MOTIR_ORG = 'motir-projects';
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');
const AUGUST_2026 = new Date('2026-08-01T00:00:00.000Z');

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_workflow_run_usage", "ci_period_usage", "ci_container_usage", "ci_container_period_cost" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  vi.stubEnv('MOTIR_CLOUD', 'true');
  vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** A runner-family entry, the shape `normalizeRunUsage` writes (§3.3). */
function breakdown(family: string, billableMinutes: number, jobCount = 1) {
  return {
    family,
    multiplier: 1,
    billableMinutes,
    rawWallClockSeconds: billableMinutes * 60,
    linearEquivalentMinutes: billableMinutes,
    jobCount,
    unpriced: false,
  };
}

interface Tenant {
  workspaceId: string;
  organizationId: string;
}

async function seedTenant(label: string): Promise<Tenant> {
  const user = await usersService.createUser({
    email: `fleet-recon-${label}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${label}`,
    ownerUserId: user.id,
  });
  return { workspaceId: workspace.id, organizationId: workspace.organizationId };
}

/** One metered run, with an explicit per-family breakdown. */
async function seedMeteredRun(
  tenant: Tenant,
  repoName: string,
  entries: ReturnType<typeof breakdown>[],
  options: { periodStart?: Date; runId?: string } = {},
): Promise<void> {
  const billableMinutes = entries.reduce((sum, e) => sum + e.billableMinutes, 0);
  await db.ciWorkflowRunUsage.create({
    data: {
      workspaceId: tenant.workspaceId,
      organizationId: tenant.organizationId,
      runId: options.runId ?? `run-${repoName}-${Math.random().toString(36).slice(2, 8)}`,
      runAttempt: 1,
      repoOwner: MOTIR_ORG,
      repoName,
      periodStart: options.periodStart ?? JULY_2026,
      runCompletedAt: new Date('2026-07-15T12:00:00.000Z'),
      billableMinutes,
      rawWallClockSeconds: new Prisma.Decimal(billableMinutes * 60),
      linearEquivalentMinutes: new Prisma.Decimal(billableMinutes),
      jobCount: entries.reduce((sum, e) => sum + e.jobCount, 0),
      runnerBreakdown: entries,
    },
  });
}

/** One torn-down container, as the cost meter persists it. `workload` defaults to
 *  the CI runner this audit is about; pass `index` / `agent` to seed a container
 *  from one of the OTHER workloads that share the fleet org (MOTIR-1995). */
async function seedContainer(
  tenant: Tenant,
  repoName: string,
  billableSeconds: number,
  periodStart: Date = JULY_2026,
  workload: 'ci' | 'index' | 'agent' = 'ci',
): Promise<void> {
  await db.ciContainerUsage.create({
    data: {
      containerProvider: 'fly',
      handleId: `m-${Math.random().toString(36).slice(2, 10)}`,
      containerRegion: 'iad',
      workspaceId: tenant.workspaceId,
      organizationId: tenant.organizationId,
      repoFullName: `${MOTIR_ORG}/${repoName}`,
      workload,
      // An index or agent container has no GitHub job at all — the whole reason it
      // cannot appear in an Actions-based audit.
      workflowJobId: workload === 'ci' ? String(44000 + Math.floor(Math.random() * 900)) : null,
      cpuKind: 'performance',
      cpus: 2,
      memoryMb: 8192,
      containerCreatedAt: new Date('2026-07-15T11:50:00.000Z'),
      containerStartedAt: new Date('2026-07-15T11:55:00.000Z'),
      containerStoppedAt: new Date('2026-07-15T12:00:00.000Z'),
      billableSeconds,
      periodStart,
      usdPerSecond: new Prisma.Decimal('0.000031636049'),
      costUsd: new Prisma.Decimal('0.000031636049').mul(billableSeconds),
      rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
      terminalState: 'destroyed',
      teardownReason: 'job_completed',
    },
  });
}

describe('the GITHUB-BILLED side excludes fleet minutes (§Q.1)', () => {
  it('a MIXED month reports only the GitHub-hosted minutes, and no drift', async () => {
    // THE CARD'S FIXTURE. One repo, one month, both substrates: 40 minutes on
    // GitHub-hosted runners and 200 on the fleet. GitHub's bill only ever
    // covered the 40. Before this change the audit compared 240 against 40 and
    // screamed; now the fleet minutes are simply not in this population.
    const tenant = await seedTenant('mixed');
    await seedMeteredRun(tenant, 'acme-web', [breakdown('linux_x64', 40, 4)]);
    await seedMeteredRun(tenant, 'acme-web', [breakdown(MOTIR_FLEET_RUNNER_FAMILY, 200, 20)]);

    const githubHosted = await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026);

    expect(githubHosted).toEqual([{ repoName: 'acme-web', billableMinutes: 40 }]);
    // And the comparison against a bill that reports exactly those 40 is clean.
    const rows = reconcileTotals(githubHosted, [
      { repositoryName: 'acme-web', sku: 'Actions Linux', quantity: 40, unitType: 'minutes' },
    ]);
    expect(rows).toEqual([
      {
        repoName: 'acme-web',
        meteredMinutes: 40,
        reportedMinutes: 40,
        driftMinutes: 0,
        exceedsTolerance: false,
      },
    ]);
  });

  it('splits a SINGLE RUN that mixed runners — per breakdown entry, not per row', async () => {
    // §Q.3: a repo that migrates mid-month is reconciled per SOURCE. A matrix
    // run with one fleet job and three hosted ones is the same problem inside a
    // single row, and a row-level predicate would have to round it one way.
    const tenant = await seedTenant('one-run');
    await seedMeteredRun(tenant, 'acme-web', [
      breakdown('linux_x64', 12, 3),
      breakdown(MOTIR_FLEET_RUNNER_FAMILY, 30, 1),
    ]);

    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([
      { repoName: 'acme-web', billableMinutes: 12 },
    ]);
    expect(await ciMinutesReconciliationService.hostingSplitForMonth(JULY_2026)).toEqual([
      { repoName: 'acme-web', githubHostedMinutes: 12, fleetMinutes: 30, fleetJobCount: 1 },
    ]);
  });

  it('drops a FULLY MIGRATED repo from the GitHub audit entirely (§Q.4)', async () => {
    // "Zero GitHub-billed minutes on a repo is a valid, expected state — it must
    // not be reported as 100% drift. It is the success condition."
    const tenant = await seedTenant('migrated');
    await seedMeteredRun(tenant, 'fleet-only', [breakdown(MOTIR_FLEET_RUNNER_FAMILY, 500, 50)]);

    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([]);
    // Nothing on either side of the GitHub comparison ⇒ no row, so no drift.
    expect(reconcileTotals([], [])).toEqual([]);
  });

  it('a row with an EMPTY breakdown still counts as GitHub-hosted — it never vanishes', async () => {
    // Every row metered before the fleet existed is GitHub-billed. A row whose
    // breakdown cannot be read must fall somewhere rather than disappear from
    // the audit, and this is the only honest place for it.
    const tenant = await seedTenant('legacy');
    await db.ciWorkflowRunUsage.create({
      data: {
        workspaceId: tenant.workspaceId,
        organizationId: tenant.organizationId,
        runId: 'run-legacy',
        runAttempt: 1,
        repoOwner: MOTIR_ORG,
        repoName: 'legacy-web',
        periodStart: JULY_2026,
        runCompletedAt: new Date('2026-07-15T12:00:00.000Z'),
        billableMinutes: 77,
        rawWallClockSeconds: new Prisma.Decimal(4620),
        linearEquivalentMinutes: new Prisma.Decimal(77),
        jobCount: 1,
        runnerBreakdown: [],
      },
    });

    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([
      { repoName: 'legacy-web', billableMinutes: 77 },
    ]);
  });

  it('is cross-tenant and month-scoped, as the GitHub bill is', async () => {
    const a = await seedTenant('org-a');
    const b = await seedTenant('org-b');
    await seedMeteredRun(a, 'a-web', [breakdown('linux_x64', 10, 1)]);
    await seedMeteredRun(b, 'b-web', [breakdown('linux_x64', 20, 2)]);
    await seedMeteredRun(a, 'a-web', [breakdown('linux_x64', 999, 1)], {
      periodStart: AUGUST_2026,
    });

    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([
      { repoName: 'a-web', billableMinutes: 10 },
      { repoName: 'b-web', billableMinutes: 20 },
    ]);
  });
});

describe('fleetToleranceFor', () => {
  it('is the shared floor plus a per-container allowance', () => {
    // max(5, 5% × 0) + 0 containers
    expect(fleetToleranceFor(0, 0)).toBe(5);
    // max(5, 5% × 100) + 3 × 2
    expect(fleetToleranceFor(100, 3)).toBe(11);
    // The fraction takes over from the floor past 100 metered minutes.
    expect(fleetToleranceFor(400, 0)).toBe(20);
  });
});

describe('reconcileFleetTotals (pure)', () => {
  it('reports no drift when the containers match the jobs they served', () => {
    // 10 jobs metered at 40 minutes; 10 containers totalling 2,460 s (41 min) —
    // the extra minute is boot and teardown, which is what the per-container
    // allowance exists for.
    const rows = reconcileFleetTotals(
      [{ repoName: 'acme-web', fleetMinutes: 40, fleetJobCount: 10 }],
      [{ repoName: 'acme-web', billableSeconds: 2460, containerCount: 10 }],
    );
    expect(rows).toEqual([
      {
        repoName: 'acme-web',
        meteredMinutes: 40,
        containerMinutes: 41,
        containerCount: 10,
        fleetJobCount: 10,
        driftMinutes: 1,
        exceedsTolerance: false,
      },
    ]);
  });

  it('tolerates the METER reading high — per-job ceil rounds every short job up', () => {
    // 40 ten-second jobs meter as 40 minutes; the containers ran ~27 minutes.
    // A rule without the per-container allowance would flag this every month on
    // any repo with short jobs — the phantom drift, arriving from the other side.
    const rows = reconcileFleetTotals(
      [{ repoName: 'short-jobs', fleetMinutes: 40, fleetJobCount: 40 }],
      [{ repoName: 'short-jobs', billableSeconds: 1600, containerCount: 40 }],
    );
    expect(rows[0]?.driftMinutes).toBeCloseTo(-13.33, 2);
    expect(rows[0]?.exceedsTolerance).toBe(false); // 13.33 < 5 + 40×2
  });

  it('FLAGS fleet minutes with NO container record — the §5 invariant failing', () => {
    const rows = reconcileFleetTotals(
      [{ repoName: 'acme-web', fleetMinutes: 200, fleetJobCount: 20 }],
      [],
    );
    expect(rows[0]).toMatchObject({
      meteredMinutes: 200,
      containerMinutes: 0,
      containerCount: 0,
      driftMinutes: -200,
      exceedsTolerance: true, // 200 > max(5, 10) + 0
    });
  });

  it('FLAGS a container that far outlived the job it served — a leak costs real money', () => {
    const rows = reconcileFleetTotals(
      [{ repoName: 'acme-web', fleetMinutes: 5, fleetJobCount: 1 }],
      [{ repoName: 'acme-web', billableSeconds: 3600, containerCount: 1 }],
    );
    expect(rows[0]).toMatchObject({
      containerMinutes: 60,
      driftMinutes: 55,
      exceedsTolerance: true,
    });
  });

  it('surfaces containers for a repo the meter never counted', () => {
    // Compute ran for a run whose `workflow_run` webhook never landed — the
    // asymmetry that only a two-source audit can see.
    const rows = reconcileFleetTotals(
      [],
      [{ repoName: 'ghost-web', billableSeconds: 3000, containerCount: 2 }],
    );
    expect(rows[0]).toMatchObject({
      repoName: 'ghost-web',
      meteredMinutes: 0,
      containerMinutes: 50,
      exceedsTolerance: true, // 50 > max(5, 0) + 2×2
    });
  });

  it('ignores a repo with no fleet activity on either side', () => {
    // A purely GitHub-hosted repo belongs to the OTHER audit; it must not appear
    // here as a row of zeroes.
    expect(
      reconcileFleetTotals([{ repoName: 'hosted-only', fleetMinutes: 0, fleetJobCount: 0 }], []),
    ).toEqual([]);
  });
});

describe('reconcileFleetMonth (against real Postgres)', () => {
  it('audits fleet minutes against the CONTAINER record, and reports no drift when they agree', async () => {
    const tenant = await seedTenant('fleet-clean');
    await seedMeteredRun(tenant, 'acme-web', [
      breakdown('linux_x64', 40, 4),
      breakdown(MOTIR_FLEET_RUNNER_FAMILY, 20, 5),
    ]);
    // Five containers, 21 minutes of runtime for 20 metered minutes.
    for (let i = 0; i < 5; i += 1) await seedContainer(tenant, 'acme-web', 252);

    const outcome = await ciMinutesReconciliationService.reconcileFleetMonth(JULY_2026);

    expect(outcome).toMatchObject({ outcome: 'reconciled', org: MOTIR_ORG });
    const reconciled = outcome as Extract<typeof outcome, { outcome: 'reconciled' }>;
    expect(reconciled.repos).toEqual([
      {
        repoName: 'acme-web',
        meteredMinutes: 20,
        containerMinutes: 21,
        containerCount: 5,
        fleetJobCount: 5,
        driftMinutes: 1,
        exceedsTolerance: false,
      },
    ]);
    expect(reconciled.discrepancies).toEqual([]);
  });

  it('IGNORES index and agent containers — they are not Actions jobs and must not read as drift', async () => {
    // ⚠️ THE PHANTOM DRIFT, ONE WORKLOAD OVER (MOTIR-1995). This audit's other side
    // is `ci_workflow_run_usage` — GitHub Actions job wall-clock. An index container
    // produces no Actions run at all (`code-graph-index-fleet.md` §11: "no runner
    // registers, no `runs-on` resolves, no `workflow_job` fires"), so every index
    // second counted here would sit on one side and never the other: one-directional
    // drift in the very repositories the fleet builds, growing with index volume and
    // attributable to nothing. That is exactly what §Q.2's audit was created to
    // REMOVE, so an unfiltered container read would have re-created it.
    const tenant = await seedTenant('fleet-mixed');
    await seedMeteredRun(tenant, 'acme-web', [breakdown(MOTIR_FLEET_RUNNER_FAMILY, 20, 5)]);
    // The CI containers that actually served those 20 metered minutes.
    for (let i = 0; i < 5; i += 1) await seedContainer(tenant, 'acme-web', 252);
    // A big index container and an agent container in the same repo and month. Left
    // in, they add 100 minutes of drift to a repo that is perfectly reconciled.
    await seedContainer(tenant, 'acme-web', 3000, JULY_2026, 'index');
    await seedContainer(tenant, 'acme-web', 3000, JULY_2026, 'agent');

    const outcome = await ciMinutesReconciliationService.reconcileFleetMonth(JULY_2026);

    const reconciled = outcome as Extract<typeof outcome, { outcome: 'reconciled' }>;
    expect(reconciled.repos).toEqual([
      {
        repoName: 'acme-web',
        meteredMinutes: 20,
        containerMinutes: 21,
        containerCount: 5,
        fleetJobCount: 5,
        driftMinutes: 1,
        exceedsTolerance: false,
      },
    ]);
    expect(reconciled.discrepancies).toEqual([]);
  });

  it('STILL REPORTS a genuine mismatch — narrowed, not disabled', async () => {
    // The other half of the acceptance. Fleet minutes were metered and no
    // container was ever recorded for them: either usage rows were lost or the
    // meter counted fleet time nothing ran.
    const tenant = await seedTenant('fleet-drift');
    await seedMeteredRun(tenant, 'acme-web', [breakdown(MOTIR_FLEET_RUNNER_FAMILY, 200, 20)]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const outcome = await ciMinutesReconciliationService.reconcileFleetMonth(JULY_2026);

    const reconciled = outcome as Extract<typeof outcome, { outcome: 'reconciled' }>;
    expect(reconciled.discrepancies).toEqual([
      expect.objectContaining({ repoName: 'acme-web', driftMinutes: -200 }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fleet meter drifted from the container record'),
      expect.objectContaining({ org: MOTIR_ORG }),
    );
  });

  it('needs NO billing credential — it audits from the first fleet job', async () => {
    // The GitHub half skips until MOTIR-1779 provisions a token. This half must
    // not: both its sources are Motir's own tables.
    vi.stubEnv('GITHUB_BILLING_TOKEN', '');
    const tenant = await seedTenant('no-token');
    await seedMeteredRun(tenant, 'acme-web', [breakdown(MOTIR_FLEET_RUNNER_FAMILY, 20, 5)]);
    for (let i = 0; i < 5; i += 1) await seedContainer(tenant, 'acme-web', 252);

    expect(await ciMinutesReconciliationService.reconcileFleetMonth(JULY_2026)).toMatchObject({
      outcome: 'reconciled',
    });
  });

  it('is skipped off-cloud', async () => {
    vi.stubEnv('MOTIR_CLOUD', '');
    expect(await ciMinutesReconciliationService.reconcileFleetMonth(JULY_2026)).toEqual({
      outcome: 'skipped',
      reason: 'metering_disabled',
    });
  });

  it('scopes containers to the period and to Motir’s own org', async () => {
    const tenant = await seedTenant('scope');
    await seedContainer(tenant, 'acme-web', 600, AUGUST_2026);
    await db.ciContainerUsage.create({
      data: {
        containerProvider: 'fly',
        handleId: 'm-foreign',
        containerRegion: 'iad',
        workspaceId: tenant.workspaceId,
        organizationId: tenant.organizationId,
        repoFullName: 'someone-else/acme-web',
        workflowJobId: '44999',
        cpuKind: 'performance',
        cpus: 2,
        memoryMb: 8192,
        containerCreatedAt: new Date('2026-07-15T11:50:00.000Z'),
        containerStartedAt: new Date('2026-07-15T11:55:00.000Z'),
        containerStoppedAt: new Date('2026-07-15T12:00:00.000Z'),
        billableSeconds: 300,
        periodStart: JULY_2026,
        usdPerSecond: new Prisma.Decimal('0.000031636049'),
        costUsd: new Prisma.Decimal('0.009490814700'),
        rateEffectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
        terminalState: 'destroyed',
        teardownReason: 'job_completed',
      },
    });

    expect(await ciMinutesReconciliationService.containerTotalsForMonth(JULY_2026)).toEqual([]);
  });
});
