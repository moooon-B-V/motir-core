import { Prisma, type JobRun } from '@prisma/client';

// Data access for the job_run ledger (Story 1.6 · Subtask 1.6.2). Single-op
// methods only; writes require `tx` (the 4-layer contract). jobRunsService
// owns the transactions and the DTO mapping.
export const jobRunRepository = {
  /** Read one run by id. Used inside the finish transaction to read startedAt. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobRun | null> {
    return tx.jobRun.findUnique({ where: { id } });
  },

  /** Insert the initial `running` row. */
  async create(data: Prisma.JobRunCreateInput, tx: Prisma.TransactionClient): Promise<JobRun> {
    return tx.jobRun.create({ data });
  },

  /** Patch a run on completion (status / finishedAt / durationMs / failure). */
  async update(
    id: string,
    data: Prisma.JobRunUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobRun> {
    return tx.jobRun.update({ where: { id }, data });
  },
};
