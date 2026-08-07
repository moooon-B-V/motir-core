import { Prisma, type CiContainerUsage } from '@/lib/generated/prisma/client';

// Data access for the per-container CONTAINER-SECONDS rows (Story MOTIR-1916 ·
// MOTIR-1924 · MOTIR-1995) — what the fleet cost MOTIR, as opposed to what the
// customer was metered. Single-op methods only (CLAUDE.md 4-layer); every write
// requires a `tx`, and the reads that guard a write take one too.
//
// ⚠️ THERE IS EXACTLY ONE WRITE PATH ONTO A ROW, AND IT IS THREE OPS, NOT ONE
// (MOTIR-1995). A row is MATERIALIZED by {@link ciContainerUsageRepository.
// createIfAbsent}, LOCKED by {@link ciContainerUsageRepository.lockAccruedState},
// then written by {@link ciContainerUsageRepository.accrue} — in that order, in one
// transaction, because the write derives the period rollup's increment from what
// the row already held (`notes.html` #35). A plain `create` no longer exists on
// purpose: it was MOTIR-1924's single settle-time insert, and leaving it beside the
// accrual path would leave a second, unlocked way to write the same record — which
// is precisely the divergence the shared-record rule exists to prevent.

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
  /**
   * NULL for a container that is still RUNNING — a checkpoint row (MOTIR-1995).
   * A settled row always carries it, together with both terminal fields below;
   * the writer enforces that pairing, not the column.
   */
  containerStoppedAt: Date | null;
  billableSeconds: number;
  periodStart: Date;
  usdPerSecond: string;
  costUsd: string;
  rateEffectiveFrom: Date | null;
  /** NULL while the container is still running — it has no terminal state and no
   *  teardown reason yet. */
  terminalState: string | null;
  teardownReason: string | null;
}

/** What the row for a handle holds RIGHT NOW, read under a lock so the caller can
 *  derive the rollup delta from it (MOTIR-1995). */
export interface CiContainerUsageAccruedState {
  /** Seconds this container has ALREADY contributed to its period rollup. */
  billableSeconds: number;
  /** The money it has already contributed. Decimal string, never floated. */
  costUsd: string;
  /** The period the row was FIRST written into — the rollup the delta must land
   *  in, whatever period the settle instant now falls in. */
  periodStart: Date;
  /** The workload line the row was written under, so the delta reaches the same
   *  rollup row rather than a sibling workload's. */
  workload: string;
  /** True once the container has ended. A settled row is FINAL: a later arrival
   *  (the reaper reaching the same handle, a replayed settle step) must change
   *  nothing. */
  settled: boolean;
}

/** The absolute figures one accrual or settle writes onto an existing row. */
export interface CiContainerUsageAccrueInput {
  containerProvider: string;
  handleId: string;
  /** TOTAL seconds to date — never a delta. See the model's own comment. */
  billableSeconds: number;
  costUsd: string;
  usdPerSecond: string;
  rateEffectiveFrom: Date | null;
  /** NULL only ever means "never started" — a settle can report it, a checkpoint
   *  cannot (a container that has not started has accrued nothing). */
  containerStartedAt: Date | null;
  /** Set ONLY by a settle; null keeps the row open for further checkpoints. */
  containerStoppedAt: Date | null;
  terminalState: string | null;
  teardownReason: string | null;
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
   * Create the row for a handle IF IT DOES NOT EXIST YET, and say whether this
   * call is the one that created it (MOTIR-1995).
   *
   * ⚠️ THIS IS HALF OF THE LOCK-BEFORE-A-READ-DERIVED-UPDATE PATTERN
   * (`notes.html` #35), and the half that is easy to miss. Accrual IS a
   * read-derived write — *read what this container already contributed → subtract
   * → increment the rollup by the difference* — so it has to serialize on the
   * row. But `SELECT … FOR UPDATE` on a row that does not exist yet locks
   * NOTHING: two first checkpoints for the same container would both read "no
   * prior", both treat their whole figure as new, and the rollup would count the
   * container's seconds twice. So the row is MATERIALIZED first, unconditionally
   * and idempotently, and only then locked — which gives {@link lockAccruedState}
   * something real to contend on in every case, first arrival included.
   *
   * ⚠️ `createMany({ skipDuplicates })` FOR ONE ROW, deliberately — it is Prisma's
   * only `INSERT … ON CONFLICT DO NOTHING`, and the count it returns is exactly the
   * "did I create it?" answer. A plain `create` in a `try/catch` on P2002 would
   * abort the surrounding Postgres transaction (25P02) and take the lock and the
   * rollup write down with it; hand-written raw SQL would work, but naming the
   * machine-class columns in one place trips the port-boundary guard, which reads
   * `cpu_kind`/`cpus`/`memory_mb` together as a Fly guest config
   * (`tests/ciFleet/orchestratorPortBoundary.test.ts`) — and the guard is right to
   * be blunt about that. The typed delegate has neither problem.
   *
   * DO NOTHING rather than an upsert: the existing row may already hold a LARGER
   * figure (a later checkpoint, or a settle), and overwriting it with this arrival's
   * would move the meter backwards. Every value written here is provisional; the
   * locked update is what decides the row's contents.
   *
   * The boolean is the `container_count` signal — a container is counted once, when
   * its row appears, never once per checkpoint (which would make the count a poll
   * tally rather than a container tally).
   */
  async createIfAbsent(
    data: CiContainerUsageCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const { count } = await tx.ciContainerUsage.createMany({
      data: [
        {
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
      ],
      skipDuplicates: true,
    });
    return count === 1;
  },

  /**
   * LOCK the row for a handle and report what it has already contributed —
   * `SELECT … FOR UPDATE`, so two concurrent accruals for the same container
   * serialize here instead of both deriving a delta from the same stale figure
   * (`notes.html` #35: a transaction guarantees atomicity, not isolation against
   * a sibling writer on the same row).
   *
   * Returns null only when the row genuinely does not exist. Callers that are
   * about to derive a delta call {@link createIfAbsent} first, precisely so this
   * can never be that case for them.
   *
   * Raw SQL because Prisma has no `FOR UPDATE` — the same reason
   * `workItemsService`'s `lockById` is raw, and the pattern this mirrors.
   */
  async lockAccruedState(
    containerProvider: string,
    handleId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiContainerUsageAccruedState | null> {
    const rows = await tx.$queryRaw<
      Array<{
        billableSeconds: number;
        costUsd: Prisma.Decimal;
        periodStart: Date;
        workload: string;
        containerStoppedAt: Date | null;
      }>
    >`
      SELECT
        "billable_seconds"     AS "billableSeconds",
        "cost_usd"             AS "costUsd",
        "period_start"         AS "periodStart",
        "workload"             AS "workload",
        "container_stopped_at" AS "containerStoppedAt"
      FROM "ci_container_usage"
      WHERE "container_provider" = ${containerProvider}
        AND "handle_id" = ${handleId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      billableSeconds: Number(row.billableSeconds),
      costUsd: new Prisma.Decimal(row.costUsd).toFixed(),
      periodStart: row.periodStart,
      workload: row.workload,
      settled: row.containerStoppedAt !== null,
    };
  },

  /**
   * Write one accrual's ABSOLUTE figures onto the locked row.
   *
   * ⚠️ `period_start` IS NOT IN THE SET LIST, and its absence is load-bearing. The
   * row is bucketed at its first write and stays there: the rollup it has already
   * been added to is the one a later settle must reconcile against, so a container
   * that runs across a month boundary keeps its original period. Re-bucketing it
   * would leave the first period's rollup permanently overstated by everything the
   * container had accrued — with no row left pointing at the discrepancy.
   *
   * The caller MUST hold {@link lockAccruedState}'s lock on this row; this method
   * makes no decision of its own and cannot serialize anything by itself.
   */
  async accrue(
    data: CiContainerUsageAccrueInput,
    tx: Prisma.TransactionClient,
  ): Promise<CiContainerUsage> {
    return tx.ciContainerUsage.update({
      where: {
        containerProvider_handleId: {
          containerProvider: data.containerProvider,
          handleId: data.handleId,
        },
      },
      data: {
        billableSeconds: data.billableSeconds,
        costUsd: new Prisma.Decimal(data.costUsd),
        usdPerSecond: new Prisma.Decimal(data.usdPerSecond),
        rateEffectiveFrom: data.rateEffectiveFrom,
        containerStartedAt: data.containerStartedAt,
        containerStoppedAt: data.containerStoppedAt,
        terminalState: data.terminalState,
        teardownReason: data.teardownReason,
      },
    });
  },

  // ⚠️ `findByHandle` IS GONE (MOTIR-1995), and its removal is part of the write
  // path becoming one path. It was MOTIR-1924's CHEAP PRE-CHECK — an unlocked read
  // that let the service skip the insert on an obvious second teardown, explicitly
  // "NOT the correctness guard". {@link lockAccruedState} now reads the same row
  // for real, under `FOR UPDATE`, on every write, so the pre-check saves nothing
  // and its only remaining effect would be to offer a caller an unlocked answer to
  // exactly the question that must never be answered without the lock.

  /**
   * Per-REPOSITORY container totals for one period across EVERY tenant, for one
   * repo owner — the fleet reconciliation's read (§Q.2).
   *
   * ⚠️ `workload = 'ci'` ONLY, AND THAT FILTER IS THE POINT OF ITS BEING HERE
   * (MOTIR-1995). This read is one side of an audit whose OTHER side is
   * `ci_workflow_run_usage` — GitHub Actions job wall-clock. An index container
   * produces no Actions run at all (`code-graph-index-fleet.md` §11: "no runner
   * registers, no `runs-on` resolves, no `workflow_job` fires"), so every index
   * second counted here would appear on one side and never the other: pure
   * one-directional drift, in the same repositories the fleet builds, growing with
   * index volume and attributable to nothing. That is exactly the phantom drift
   * §Q.2's audit was created to REMOVE — reintroduced by a second workload rather
   * than by a vendor's billing report (`notes.html` #185, one quantity over).
   *
   * The filter lives in the SQL rather than in the reconciliation service because
   * the constraint is a property of what this read means, not of one caller's
   * intent: any future consumer comparing containers against Actions jobs needs
   * the same restriction, and a filter a caller must remember is one a caller will
   * forget.
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
        AND "workload" = 'ci'
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
