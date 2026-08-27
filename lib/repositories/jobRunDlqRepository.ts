import { Prisma, type JobRunDlq } from '@/generated/prisma/client';

// Data access for the dead-letter queue (Story 1.6 · Subtask 1.6.4). Single-op
// methods only; writes require `tx` (the 4-layer contract). jobRunsService owns
// the dead-letter transaction (write the DLQ row + flip the job_run together);
// replayDLQ (lib/jobs/dlq.ts) owns the replay transaction. The DTO mapping lives
// in lib/mappers/jobMappers.ts.
export const jobRunDlqRepository = {
  /** Read one DLQ entry by id. Used inside the replay transaction. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobRunDlq | null> {
    return tx.jobRunDlq.findUnique({ where: { id } });
  },

  /**
   * Insert a dead-letter row when a run exhausts its retry budget. Uses the
   * UNCHECKED create input (scalar `workspaceId` FK) for the same reason as
   * jobRunRepository.create: the writer runs under the system-admin context
   * with no workspace context, so a `connect` SELECT on `workspace` would be
   * RLS-hidden. The Postgres FK still enforces existence.
   */
  async create(
    data: Prisma.JobRunDlqUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq> {
    return tx.jobRunDlq.create({ data });
  },

  /** Stamp `replayedAt` when an operator replays the entry. */
  async update(
    id: string,
    data: Prisma.JobRunDlqUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq> {
    return tx.jobRunDlq.update({ where: { id }, data });
  },

  /**
   * Dashboard DLQ-tab read (1.6.5): a workspace's dead-letter entries,
   * newest-failure-first, paged. Takes `tx` (runs under withWorkspaceContext;
   * explicit workspaceId scope is defense-in-depth like jobRunRepository).
   * Serves the `[workspaceId, lastFailedAt desc]` index from the 1.6.4 schema.
   */
  async listByWorkspace(
    workspaceId: string,
    opts: { limit: number; offset: number },
    tx: Prisma.TransactionClient,
  ): Promise<JobRunDlq[]> {
    return tx.jobRunDlq.findMany({
      where: { workspaceId },
      orderBy: { lastFailedAt: 'desc' },
      take: opts.limit,
      skip: opts.offset,
    });
  },

  /**
   * Count of ACTIVE (not-yet-replayed) dead-letter entries for the DLQ-tab
   * badge. Excludes replayed rows (`replayedAt IS NOT NULL`) so the badge
   * reflects entries still needing operator attention, per the 1.6.5 AC.
   */
  async countActiveByWorkspace(workspaceId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobRunDlq.count({ where: { workspaceId, replayedAt: null } });
  },

  /**
   * Count of ACTIVE dead-letter entries across EVERY workspace, optionally only
   * those that failed since a moment — the operator console's "Failed jobs"
   * signal (MOTIR-1167, design Panel 8's 24-hour figure).
   *
   * No workspace filter, so the caller MUST supply a `withSystemContext` tx —
   * the same requirement, for the same reason, as `jobRunRepository.listAll`:
   * that is the only RLS branch admitting the untenanted `workspace_id IS NULL`
   * rows every `system.*` job writes, and a system job dead-lettering is exactly
   * the case this signal exists to show.
   *
   * `replayedAt: null` is the same predicate the per-workspace badge uses:
   * entries an operator has already retried are not still asking for attention.
   */
  async countActiveSince(since: Date | null, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobRunDlq.count({
      where: { replayedAt: null, ...(since ? { lastFailedAt: { gte: since } } : {}) },
    });
  },
};
