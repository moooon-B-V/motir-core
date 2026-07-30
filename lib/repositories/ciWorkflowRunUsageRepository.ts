import { Prisma, type CiWorkflowRunUsage } from '@prisma/client';

// Data access for the per-run CI-metering AUDIT rows (Story MOTIR-1775 ·
// MOTIR-1896). Single-op methods only (CLAUDE.md 4-layer); every write requires
// a `tx`, and the reads that guard a write take one too.

export interface CiWorkflowRunUsageCreateInput {
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  githubRepoId: string | null;
  runId: string;
  runAttempt: number;
  repoOwner: string;
  repoName: string;
  workflowName: string | null;
  periodStart: Date;
  runCompletedAt: Date;
  billableMinutes: number;
  rawWallClockSeconds: number;
  linearEquivalentMinutes: number;
  jobCount: number;
  runnerBreakdown: Prisma.InputJsonValue;
}

/** One repo's metered totals for a period — the shape the monthly
 *  reconciliation compares against GitHub's own billing report (§5.8). */
export interface RepoPeriodTotal {
  repoOwner: string;
  repoName: string;
  billableMinutes: number;
  linearEquivalentMinutes: number;
  runCount: number;
}

export const ciWorkflowRunUsageRepository = {
  /**
   * Insert one metered run. The `(run_id, run_attempt)` unique index is the real
   * idempotency guard (`ci-minutes-allowance.md` §5.8) — a redelivery raises
   * P2002 here, which the service translates to a `duplicate` outcome. Because
   * this shares a transaction with the period increment, that failure rolls the
   * increment back too, so a duplicate can never inflate the rollup.
   */
  async create(
    data: CiWorkflowRunUsageCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CiWorkflowRunUsage> {
    return tx.ciWorkflowRunUsage.create({
      data: {
        workspaceId: data.workspaceId,
        organizationId: data.organizationId,
        projectId: data.projectId,
        githubRepoId: data.githubRepoId,
        runId: data.runId,
        runAttempt: data.runAttempt,
        repoOwner: data.repoOwner,
        repoName: data.repoName,
        workflowName: data.workflowName,
        periodStart: data.periodStart,
        runCompletedAt: data.runCompletedAt,
        billableMinutes: data.billableMinutes,
        rawWallClockSeconds: new Prisma.Decimal(data.rawWallClockSeconds),
        linearEquivalentMinutes: new Prisma.Decimal(data.linearEquivalentMinutes),
        jobCount: data.jobCount,
        runnerBreakdown: data.runnerBreakdown,
      },
    });
  },

  /**
   * The already-metered row for a run attempt, if any. A CHEAP pre-check that
   * lets the service skip the GitHub jobs fetch on an obvious redelivery — it is
   * NOT the correctness guard (two concurrent deliveries would both miss it).
   * The unique index is; this only saves an API round-trip in the common case.
   */
  async findByRunAndAttempt(
    runId: string,
    runAttempt: number,
    tx: Prisma.TransactionClient,
  ): Promise<CiWorkflowRunUsage | null> {
    return tx.ciWorkflowRunUsage.findUnique({ where: { runId_runAttempt: { runId, runAttempt } } });
  },

  /**
   * Per-REPOSITORY metered totals for one org and period — the reconciliation's
   * side of the comparison with GitHub's `usageItems[]`, which carries
   * `repositoryName` and is summarised per repo per day (§5.8).
   *
   * Raw SQL because this is an aggregate the Prisma delegate cannot express as
   * one op (a grouped SUM over two columns), and CLAUDE.md lists `$queryRaw` as a
   * legal single repository operation. Every column is aliased to camelCase.
   */
  async sumByRepoForOrgPeriod(
    organizationId: string,
    periodStart: Date,
    periodEnd: Date,
    tx: Prisma.TransactionClient,
  ): Promise<RepoPeriodTotal[]> {
    const rows = await tx.$queryRaw<
      Array<{
        repoOwner: string;
        repoName: string;
        billableMinutes: bigint | number;
        linearEquivalentMinutes: Prisma.Decimal;
        runCount: bigint | number;
      }>
    >`
      SELECT
        "repo_owner"                          AS "repoOwner",
        "repo_name"                           AS "repoName",
        COALESCE(SUM("billable_minutes"), 0)  AS "billableMinutes",
        COALESCE(SUM("linear_equivalent_minutes"), 0) AS "linearEquivalentMinutes",
        COUNT(*)                              AS "runCount"
      FROM "ci_workflow_run_usage"
      WHERE "organization_id" = ${organizationId}
        AND "period_start" >= ${periodStart}
        AND "period_start" < ${periodEnd}
      GROUP BY "repo_owner", "repo_name"
      ORDER BY "repo_owner" ASC, "repo_name" ASC
    `;
    return rows.map((row) => ({
      repoOwner: row.repoOwner,
      repoName: row.repoName,
      billableMinutes: Number(row.billableMinutes),
      linearEquivalentMinutes: Number(row.linearEquivalentMinutes),
      runCount: Number(row.runCount),
    }));
  },

  /**
   * Per-repository metered totals for one period across EVERY tenant, for one
   * repo owner — the monthly reconciliation's own read (§5.8).
   *
   * Cross-tenant on purpose, and safe: the reconciliation compares Motir's meter
   * against MOTIR'S OWN GitHub bill, which is org-wide by construction (GitHub
   * bills the repository owner, and that owner is Motir). Scoping it per tenant
   * would make the comparison impossible — no single tenant sees the whole bill.
   * The owner filter keeps it to Motir's own provisioning org, and the caller
   * runs it under `withSystemContext`, the shipped context for exactly this kind
   * of operator-tier, cross-workspace read.
   */
  async sumByRepoForOwnerPeriod(
    repoOwner: string,
    periodStart: Date,
    periodEnd: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ repoName: string; billableMinutes: number }>> {
    const rows = await tx.$queryRaw<Array<{ repoName: string; billableMinutes: bigint | number }>>`
      SELECT
        "repo_name"                          AS "repoName",
        COALESCE(SUM("billable_minutes"), 0) AS "billableMinutes"
      FROM "ci_workflow_run_usage"
      WHERE LOWER("repo_owner") = LOWER(${repoOwner})
        AND "period_start" >= ${periodStart}
        AND "period_start" < ${periodEnd}
      GROUP BY "repo_name"
      ORDER BY "repo_name" ASC
    `;
    return rows.map((row) => ({
      repoName: row.repoName,
      billableMinutes: Number(row.billableMinutes),
    }));
  },
};
