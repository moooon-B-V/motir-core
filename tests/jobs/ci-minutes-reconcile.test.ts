import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  ciMinutesReconcile,
  CI_MINUTES_RECONCILE_CRON,
} from '@/lib/jobs/definitions/ciMinutesReconcile';
import { jobFunctions } from '@/lib/jobs/registry';
import { ciMinutesReconciliationService } from '@/lib/services/ciMinutesReconciliationService';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';

// system.ci-minutes-reconcile (Story MOTIR-1775 · MOTIR-1896) — the monthly
// audit of the meter against GitHub's own billing report
// (`docs/decisions/ci-minutes-allowance.md` §5.8), driven IN-PROCESS via
// @inngest/test against a REAL Postgres. The GitHub billing endpoint is the one
// stubbed external (global `fetch`).

const MOTIR_ORG = 'motir-projects';
const JULY_2026 = new Date('2026-07-01T00:00:00.000Z');

beforeEach(async () => {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "ci_workflow_run_usage", "ci_period_usage" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** One metered run in July 2026, on a Motir-org repo. */
async function seedMeteredRun(repoName: string, billableMinutes: number): Promise<void> {
  const user = await usersService.createUser({
    email: `recon-${repoName}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${repoName}`,
    ownerUserId: user.id,
  });
  await db.ciWorkflowRunUsage.create({
    data: {
      workspaceId: workspace.id,
      organizationId: workspace.organizationId,
      runId: `run-${repoName}`,
      runAttempt: 1,
      repoOwner: MOTIR_ORG,
      repoName,
      periodStart: JULY_2026,
      runCompletedAt: new Date('2026-07-15T12:00:00.000Z'),
      billableMinutes,
      rawWallClockSeconds: new Prisma.Decimal(billableMinutes * 60),
      linearEquivalentMinutes: new Prisma.Decimal(billableMinutes),
      jobCount: 1,
      runnerBreakdown: [],
    },
  });
}

function stubBillingReport(items: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ usageItems: items }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

describe('system.ci-minutes-reconcile', () => {
  it('is registered on the cron the serve route mounts', () => {
    expect(jobFunctions).toContain(ciMinutesReconcile);
    // The 3rd, not the 1st: GitHub's usage report is not complete the instant a
    // month ends, so reconciling immediately would report lag as drift.
    expect(CI_MINUTES_RECONCILE_CRON).toBe('0 4 3 * *');
  });

  it('skips the GitHub half with no billing credential — but STILL audits the fleet', async () => {
    // The normal state until MOTIR-1779 provisions the org + credential. The
    // operational meter does not depend on it, so this must not look like a
    // failure — and since MOTIR-1924 the FLEET half does not depend on it at
    // all, so it reconciles anyway. That asymmetry is the point of running the
    // two comparisons as separate steps (§Q.2).
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    vi.stubEnv('GITHUB_BILLING_TOKEN', undefined);

    const { result } = await new InngestTestEngine({ function: ciMinutesReconcile }).execute();

    expect(result).toMatchObject({
      github: { outcome: 'skipped', reason: 'no_billing_credential' },
      fleet: { outcome: 'reconciled', org: MOTIR_ORG, repos: [], discrepancies: [] },
    });
    const runs = await db.jobRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      functionId: 'system.ci-minutes-reconcile',
      eventName: 'scheduled.system.ci-minutes-reconcile',
      status: 'succeeded',
      workspaceId: null, // untenanted, like every system.* job
    });
  });

  it('compares the PREVIOUS month’s metered totals against the billing report', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    vi.stubEnv('GITHUB_BILLING_TOKEN', 'ghp_audit');
    vi.setSystemTime(new Date('2026-08-03T04:00:00.000Z'));
    await seedMeteredRun('acme-web', 190);
    await seedMeteredRun('quiet-repo', 10);
    stubBillingReport([
      {
        repositoryName: 'acme-web',
        sku: 'Actions Linux',
        quantity: 195,
        unitType: 'minutes',
        date: '2026-07-15',
      },
      {
        repositoryName: 'quiet-repo',
        sku: 'Actions Linux',
        quantity: 10,
        unitType: 'minutes',
        date: '2026-07-15',
      },
    ]);

    const { result } = await new InngestTestEngine({ function: ciMinutesReconcile }).execute();

    expect(result).toMatchObject({
      github: { outcome: 'reconciled', org: MOTIR_ORG, year: 2026, month: 7 },
    });
    const reconciled = (
      result as {
        github: {
          repos: Array<{ repoName: string; meteredMinutes: number }>;
          discrepancies: unknown[];
        };
      }
    ).github;
    expect(reconciled.repos.map((r) => r.repoName)).toEqual(['acme-web', 'quiet-repo']);
    expect(reconciled.repos.find((r) => r.repoName === 'acme-web')?.meteredMinutes).toBe(190);
    // 5 minutes off 195 is inside the 5% tolerance — reporting granularity, not a bug.
    expect(reconciled.discrepancies).toEqual([]);
    vi.useRealTimers();
  });

  it('LOGS a repo GitHub billed that the meter never saw', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'true');
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    vi.stubEnv('GITHUB_BILLING_TOKEN', 'ghp_audit');
    vi.setSystemTime(new Date('2026-08-03T04:00:00.000Z'));
    stubBillingReport([
      {
        repositoryName: 'ghost-repo',
        sku: 'Actions Linux',
        quantity: 900,
        unitType: 'minutes',
        date: '2026-07-15',
      },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { result } = await new InngestTestEngine({ function: ciMinutesReconcile }).execute();

    const reconciled = (
      result as {
        github: { discrepancies: Array<{ repoName: string; driftMinutes: number }> };
      }
    ).github;
    expect(reconciled.discrepancies).toEqual([
      expect.objectContaining({ repoName: 'ghost-repo', driftMinutes: -900 }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('drifted from GitHub billing'),
      expect.objectContaining({ year: 2026, month: 7 }),
    );
    vi.useRealTimers();
  });
});

describe('ciMinutesReconciliationService.githubHostedTotalsForMonth', () => {
  it('sums the month per repository, across every tenant', async () => {
    // Cross-tenant on purpose: Motir's GitHub bill is org-wide, so no single
    // tenant sees the whole of it.
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    await seedMeteredRun('acme-web', 190);
    await seedMeteredRun('second-web', 40);

    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([
      { repoName: 'acme-web', billableMinutes: 190 },
      { repoName: 'second-web', billableMinutes: 40 },
    ]);
  });

  it('excludes other months and other repo owners', async () => {
    vi.stubEnv('GITHUB_FALLBACK_ORG', MOTIR_ORG);
    await seedMeteredRun('acme-web', 190);

    expect(
      await ciMinutesReconciliationService.githubHostedTotalsForMonth(
        new Date('2026-08-01T00:00:00.000Z'),
      ),
    ).toEqual([]);

    vi.stubEnv('GITHUB_FALLBACK_ORG', 'someone-else');
    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([]);
  });

  it('matches the owner case-insensitively, as GitHub logins are', async () => {
    await seedMeteredRun('acme-web', 190);
    vi.stubEnv('GITHUB_FALLBACK_ORG', 'MOTIR-PROJECTS');
    expect(await ciMinutesReconciliationService.githubHostedTotalsForMonth(JULY_2026)).toEqual([
      { repoName: 'acme-web', billableMinutes: 190 },
    ]);
  });
});
