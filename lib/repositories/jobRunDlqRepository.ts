import { Prisma, type JobRunDlq } from '@prisma/client';

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
};
