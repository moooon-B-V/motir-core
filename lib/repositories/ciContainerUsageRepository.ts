import { Prisma, type CiContainerUsage } from '@prisma/client';

// Data access for the per-runner CONTAINER-SECONDS rows (Story MOTIR-1916 ·
// MOTIR-1924) — what the fleet cost MOTIR, as opposed to what the customer was
// metered. Single-op methods only (CLAUDE.md 4-layer); every write requires a
// `tx`, and the reads that guard a write take one too.

/** Which fleet workload a container ran. The fleet org is SHARED — CI runners,
 *  code-graph index containers (MOTIR-1981) and, later, Epic 9's hosted agents
 *  all bill one uncapped Fly account — so every row must say which it was, or
 *  three margins collapse into one number. Required (not defaulted) on the way
 *  in: a writer that will not name its workload is a writer that will be
 *  mis-attributed silently. */
export type CiContainerWorkload = 'ci' | 'index' | 'agent';

export interface CiContainerUsageCreateInput {
  containerProvider: string;
  handleId: string;
  containerRegion: string;
  workspaceId: string;
  organizationId: string;
  projectId: string | null;
  workload: CiContainerWorkload;
  repoFullName: string;
  /** NULL for any workload that is not `ci` — only a CI container has a GitHub
   *  job. Required in practice when `workload === 'ci'`. */
  workflowJobId: string | null;
  cpuKind: string;
  cpus: number;
  memoryMb: number;
  containerCreatedAt: Date;
  containerStartedAt: Date | null;
  containerStoppedAt: Date;
  billableSeconds: number;
  periodStart: Date;
  usdPerSecond: string;
  costUsd: string;
  rateEffectiveFrom: Date | null;
  terminalState: string;
  teardownReason: string;
}

/** One repository's container totals for a period — the fleet reconciliation's
 *  own side of the comparison (`ci-minutes-allowance.md` §Q.2). */
export interface RepoContainerTotal {
  repoName: string;
  billableSeconds: number;
  containerCount: number;
}

export const ciContainerUsageRepository = {
  /**
   * Insert one container's cost record. The `(container_provider, handle_id)`
   * unique index is the real idempotency guard — the `finally` that guarantees
   * teardown and the reaper can both reach the SAME handle (teardown is required
   * to be idempotent), so the second arrival raises P2002 here and the service
   * translates it to a `duplicate` outcome. Because this shares a transaction
   * with the period increment, that failure rolls the increment back too, and a
   * duplicate can never inflate the rollup.
   */
  async create(
    data: CiContainerUsageCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<CiContainerUsage> {
    return tx.ciContainerUsage.create({
      data: {
        containerProvider: data.containerProvider,
        handleId: data.handleId,
        containerRegion: data.containerRegion,
        workspaceId: data.workspaceId,
        organizationId: data.organizationId,
        projectId: data.projectId,
        workload: data.workload,
        repoFullName: data.repoFullName,
        workflowJobId: data.workflowJobId,
        cpuKind: data.cpuKind,
        cpus: data.cpus,
        memoryMb: data.memoryMb,
        containerCreatedAt: data.containerCreatedAt,
        containerStartedAt: data.containerStartedAt,
        containerStoppedAt: data.containerStoppedAt,
        billableSeconds: data.billableSeconds,
        periodStart: data.periodStart,
        usdPerSecond: new Prisma.Decimal(data.usdPerSecond),
        costUsd: new Prisma.Decimal(data.costUsd),
        rateEffectiveFrom: data.rateEffectiveFrom,
        terminalState: data.terminalState,
        teardownReason: data.teardownReason,
      },
    });
  },

  /**
   * The already-recorded row for a handle, if any — the CHEAP pre-check that
   * lets the service skip the write path on an obvious second teardown. NOT the
   * correctness guard (two concurrent callers would both miss it); the unique
   * index is.
   */
  async findByHandle(
    containerProvider: string,
    handleId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiContainerUsage | null> {
    return tx.ciContainerUsage.findUnique({
      where: { containerProvider_handleId: { containerProvider, handleId } },
    });
  },

  /**
   * Per-REPOSITORY container totals for one period across EVERY tenant, for one
   * repo owner — the fleet reconciliation's read (§Q.2).
   *
   * Cross-tenant on purpose, and safe for the reason the minute meter's
   * owner-scoped read is: this compares Motir's own two records of its own
   * infrastructure, which is org-wide by construction. The caller runs it under
   * `withSystemContext`, the shipped context for exactly this kind of
   * operator-tier, cross-workspace read.
   *
   * The port carries ONE `repoFullName` string, so the owner filter and the
   * repo key are both derived from it with `split_part` rather than from two
   * columns — the metered side keys on `repo_name`, and these have to meet.
   *
   * Raw SQL because this is an aggregate the Prisma delegate cannot express as
   * one op (a grouped SUM + COUNT over a derived key), which CLAUDE.md lists as
   * a legal single repository operation. Every column is aliased to camelCase.
   */
  async sumByRepoForOwnerPeriod(
    repoOwner: string,
    periodStart: Date,
    periodEnd: Date,
    tx: Prisma.TransactionClient,
  ): Promise<RepoContainerTotal[]> {
    const rows = await tx.$queryRaw<
      Array<{
        repoName: string;
        billableSeconds: bigint | number;
        containerCount: bigint | number;
      }>
    >`
      SELECT
        split_part("repo_full_name", '/', 2)   AS "repoName",
        COALESCE(SUM("billable_seconds"), 0)   AS "billableSeconds",
        COUNT(*)                               AS "containerCount"
      FROM "ci_container_usage"
      WHERE LOWER(split_part("repo_full_name", '/', 1)) = LOWER(${repoOwner})
        AND "period_start" >= ${periodStart}
        AND "period_start" < ${periodEnd}
      GROUP BY split_part("repo_full_name", '/', 2)
      ORDER BY split_part("repo_full_name", '/', 2) ASC
    `;
    return rows.map((row) => ({
      repoName: row.repoName,
      billableSeconds: Number(row.billableSeconds),
      containerCount: Number(row.containerCount),
    }));
  },
};
