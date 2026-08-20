import { Prisma } from '@/generated/prisma/client';

// Data access for WHAT A HANDLE'S SECONDS WERE SPENT ON (Story MOTIR-3249 ·
// Subtask MOTIR-3255) — the finer read under `ci_container_usage`, for the case
// where one container served more than one repo. Single-op methods only
// (CLAUDE.md 4-layer); every write takes the caller's `tx`, because a slice is
// only ever written inside the transaction that writes its handle's figure.
//
// ⚠️ A SLICE IS NEVER A SOURCE FOR THE HANDLE'S TOTAL. `ci_container_usage` holds
// what the machine cost and feeds the org × workload rollup; these rows say how
// that same total divides. Two records that both claim to be the total is exactly
// the "second interpretation of the same record" MOTIR-3255 forbids — so nothing
// here sums slices into a period rollup, and the one arithmetic relation between
// the two levels is asserted rather than assumed: Σ slices = the handle's
// `billable_seconds`.
//
// ⚠️ EVERY WRITE IS ABSOLUTE-TO-DATE AND IDEMPOTENT, the same discipline the
// parent's `billable_seconds` follows. Supervision runs as durable Inngest steps
// that re-execute on replay, so a slice write states the slice's TOTAL so far and
// upserts on `(provider, handle, sliceRef)`. A replayed checkpoint therefore costs
// nothing, and double-counting is not expressible.

/** The reserved `sliceRef` of the DERIVED idle slice.
 *
 *  Idle is the writer's own row — the handle's lifetime minus the work reported
 *  against it — so it needs a key the writer owns. Double underscores keep it
 *  outside the space of run ids, which are cuids. */
export const IDLE_SLICE_REF = '__idle__';

/** `work` — attributed to a project — or the derived `idle` remainder. An
 *  explicit kind rather than "a work slice whose project is null": the two are
 *  different claims, and inferring one from a null is the second interpretation
 *  this table exists to avoid. */
export type CiContainerUsageSliceKind = 'work' | 'idle';

export interface CiContainerUsageSliceInput {
  containerProvider: string;
  handleId: string;
  sliceRef: string;
  kind: CiContainerUsageSliceKind;
  workspaceId: string;
  organizationId: string;
  /** NULL on an `idle` slice — the org owns idle, and the org is on the row. */
  projectId: string | null;
  repoFullName: string | null;
  /** ABSOLUTE-TO-DATE for this slice, never a delta. */
  seconds: number;
  usdPerSecond: string;
  costUsd: string;
  periodStart: Date;
}

export interface CiContainerUsageSliceRow {
  sliceRef: string;
  kind: CiContainerUsageSliceKind;
  projectId: string | null;
  repoFullName: string | null;
  seconds: number;
  costUsd: string;
}

/** What one project's share of the fleet cost in a period — the read that keeps
 *  "what did indexing cost us for project X" answerable once a handle can serve
 *  several. `projectId` null is the ORG's own line (idle). */
export interface ProjectSliceTotal {
  projectId: string | null;
  seconds: number;
  costUsd: string;
  sliceCount: number;
}

export const ciContainerUsageSliceRepository = {
  /**
   * Write one slice's TOTAL so far, creating it or overwriting it.
   *
   * An upsert rather than an insert because the caller may be a replay, and
   * rather than an increment because the figure is absolute — the same reason
   * `ciContainerUsageRepository.accrue` writes a total. The unique key is the
   * idempotency key, so a replayed checkpoint rewrites the same number.
   */
  async upsert(data: CiContainerUsageSliceInput, tx: Prisma.TransactionClient): Promise<void> {
    const shared = {
      kind: data.kind,
      workspaceId: data.workspaceId,
      organizationId: data.organizationId,
      projectId: data.projectId,
      repoFullName: data.repoFullName,
      seconds: data.seconds,
      usdPerSecond: new Prisma.Decimal(data.usdPerSecond),
      costUsd: new Prisma.Decimal(data.costUsd),
      periodStart: data.periodStart,
    };
    await tx.ciContainerUsageSlice.upsert({
      where: {
        containerProvider_handleId_sliceRef: {
          containerProvider: data.containerProvider,
          handleId: data.handleId,
          sliceRef: data.sliceRef,
        },
      },
      create: {
        containerProvider: data.containerProvider,
        handleId: data.handleId,
        sliceRef: data.sliceRef,
        ...shared,
      },
      // The period is NOT updated: it is pinned at the parent's first write, and a
      // slice must never land in a bucket its own handle is not in.
      update: {
        kind: shared.kind,
        projectId: shared.projectId,
        repoFullName: shared.repoFullName,
        seconds: shared.seconds,
        usdPerSecond: shared.usdPerSecond,
        costUsd: shared.costUsd,
      },
    });
  },

  /** Σ seconds already attributed to WORK on this handle — the figure the derived
   *  idle slice is the complement of. Excludes the idle slice, which is what makes
   *  deriving idle from it terminate rather than compound. */
  async sumWorkSecondsForHandle(
    containerProvider: string,
    handleId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.ciContainerUsageSlice.aggregate({
      where: { containerProvider, handleId, kind: 'work' },
      _sum: { seconds: true },
    });
    return result._sum.seconds ?? 0;
  },

  /** Every slice of one handle — the reconciliation read. Ordered so a reader (and
   *  a test) sees the same sequence twice. */
  async listForHandle(
    containerProvider: string,
    handleId: string,
    tx: Prisma.TransactionClient,
  ): Promise<CiContainerUsageSliceRow[]> {
    const rows = await tx.ciContainerUsageSlice.findMany({
      where: { containerProvider, handleId },
      orderBy: [{ kind: 'asc' }, { sliceRef: 'asc' }],
      select: {
        sliceRef: true,
        kind: true,
        projectId: true,
        repoFullName: true,
        seconds: true,
        costUsd: true,
      },
    });
    return rows.map((row) => ({
      sliceRef: row.sliceRef,
      kind: row.kind as CiContainerUsageSliceKind,
      projectId: row.projectId,
      repoFullName: row.repoFullName,
      seconds: row.seconds,
      costUsd: row.costUsd.toFixed(),
    }));
  },

  /**
   * What each project of one org cost in a period, across every handle.
   *
   * The null-`projectId` group is the org's OWN line — idle — and it is returned
   * rather than filtered out, because a reader who cannot see it would find the
   * project totals mysteriously short of the org's rollup.
   */
  async sumByProjectForOrgPeriod(
    organizationId: string,
    periodStart: Date,
    tx: Prisma.TransactionClient,
  ): Promise<ProjectSliceTotal[]> {
    const rows = await tx.ciContainerUsageSlice.groupBy({
      by: ['projectId'],
      where: { organizationId, periodStart },
      _sum: { seconds: true, costUsd: true },
      _count: { _all: true },
      orderBy: { projectId: 'asc' },
    });
    return rows.map((row) => ({
      projectId: row.projectId,
      seconds: row._sum.seconds ?? 0,
      costUsd: (row._sum.costUsd ?? new Prisma.Decimal(0)).toFixed(),
      sliceCount: row._count._all,
    }));
  },
};
