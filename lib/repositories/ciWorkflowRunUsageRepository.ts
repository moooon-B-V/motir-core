import { Prisma, type CiWorkflowRunUsage } from '@/lib/generated/prisma/client';

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

/** One repo's metered minutes for a period, split by WHO RAN THE COMPUTE — the
 *  two populations the corrected reconciliation audits against two different
 *  sources (`ci-minutes-allowance.md` §Q). `fleetJobCount` is carried because
 *  the fleet audit's tolerance scales with the number of containers a repo's
 *  jobs implied, one container per job. */
export interface RepoHostingSplit {
  repoName: string;
  githubHostedMinutes: number;
  fleetMinutes: number;
  fleetJobCount: number;
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
   * Per-repository metered totals for one period across EVERY tenant, SPLIT BY
   * WHO RAN THE COMPUTE — the read the corrected reconciliation is built on
   * (`ci-minutes-allowance.md` §Q).
   *
   * ⚠️ THE SPLIT IS PER BREAKDOWN ENTRY, NOT PER ROW, and that is the whole
   * reason it needs no schema change or backfill. §Q.3: "a repo that MIGRATES
   * mid-month is reconciled per source, not per repo-month" — and a single
   * `workflow_run` can itself mix runners (a matrix with one fleet job and three
   * GitHub-hosted ones), which a row-level predicate would have to round one way
   * or the other. `runner_breakdown` already stores Σ billable minutes per
   * runner FAMILY (§3.3, kept so a repricing needs no backfill), so unnesting it
   * splits the month exactly, with every minute landing on the side that
   * actually billed for it.
   *
   * The `jsonb_typeof` guard is not decoration: `jsonb_array_elements` ERRORS on
   * a non-array, and it is evaluated per row by the lateral join before any
   * WHERE clause could exclude one. Every row the meter writes carries an array,
   * so this only ever costs a type check — but a single malformed row would
   * otherwise take down the whole monthly audit, which is precisely the signal
   * that must not go dark.
   *
   * ⚠️ `LEFT JOIN LATERAL … ON TRUE`, NOT `CROSS JOIN` — a row with an EMPTY or
   * unreadable breakdown must not VANISH from the audit. A cross join drops it
   * silently, which is the same "the signal went dark" failure the guard above
   * prevents, arriving through the join instead of an error. Such a row falls to
   * its own `billable_minutes` on the GITHUB-hosted side: that is what every row
   * metered before the fleet existed is, so the fallback preserves the
   * pre-amendment behaviour exactly for the population it can apply to.
   *
   * Cross-tenant, `withSystemContext`, owner-filtered: the same posture (and the
   * same reasoning) as `sumByRepoForOwnerPeriod` below.
   */
  async sumByRunnerHostingForOwnerPeriod(
    repoOwner: string,
    periodStart: Date,
    periodEnd: Date,
    fleetFamily: string,
    tx: Prisma.TransactionClient,
  ): Promise<RepoHostingSplit[]> {
    const rows = await tx.$queryRaw<
      Array<{
        repoName: string;
        githubHostedMinutes: Prisma.Decimal | number;
        fleetMinutes: Prisma.Decimal | number;
        fleetJobCount: Prisma.Decimal | number;
      }>
    >`
      SELECT
        u."repo_name" AS "repoName",
        COALESCE(SUM(
          CASE
            WHEN entry IS NULL THEN u."billable_minutes"
            WHEN entry->>'family' <> ${fleetFamily}
              THEN (entry->>'billableMinutes')::numeric
            ELSE 0
          END
        ), 0) AS "githubHostedMinutes",
        COALESCE(SUM(
          CASE WHEN entry->>'family' = ${fleetFamily}
               THEN (entry->>'billableMinutes')::numeric ELSE 0 END
        ), 0) AS "fleetMinutes",
        COALESCE(SUM(
          CASE WHEN entry->>'family' = ${fleetFamily}
               THEN (entry->>'jobCount')::numeric ELSE 0 END
        ), 0) AS "fleetJobCount"
      FROM "ci_workflow_run_usage" u
      LEFT JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(u."runner_breakdown") = 'array'
             THEN u."runner_breakdown" ELSE '[]'::jsonb END
      ) AS entry ON TRUE
      WHERE LOWER(u."repo_owner") = LOWER(${repoOwner})
        AND u."period_start" >= ${periodStart}
        AND u."period_start" < ${periodEnd}
      GROUP BY u."repo_name"
      ORDER BY u."repo_name" ASC
    `;
    return rows.map((row) => ({
      repoName: row.repoName,
      githubHostedMinutes: Number(row.githubHostedMinutes),
      fleetMinutes: Number(row.fleetMinutes),
      fleetJobCount: Number(row.fleetJobCount),
    }));
  },

  // ⚠️ `sumByRepoForOwnerPeriod` — the un-split owner read this file used to
  // carry — was REMOVED by MOTIR-1924, not left beside its replacement. It
  // summed EVERY metered minute for an owner, which is the population §Q now
  // forbids comparing against GitHub's billing report; leaving it here would
  // leave a correct-looking read whose only remaining use would be the bug the
  // amendment exists to fix. `sumByRunnerHostingForOwnerPeriod` above answers
  // the same question with the split the audit requires.
};
