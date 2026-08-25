import { Prisma, type JobEvent } from '@/generated/prisma/client';

// Data access for `job_event` — the emitted-event log the dispatcher fans out
// from (Story MOTIR-3414 · Subtask MOTIR-3423). Single-op methods only; writes
// require `tx` (the 4-layer contract). `lib/jobs/engine/dispatcher.ts` owns the
// transactions.
//
// Writes use the UNCHECKED create input (scalar `workspaceId` FK) rather than a
// relation `connect`, for the reason `jobRunRepository.create` records: the job
// runtime writes under the system-admin context with no workspace context bound,
// and a `connect` issues a SELECT on `workspace` that the workspace table's RLS
// hides.
export const jobEventRepository = {
  /** Insert one emitted event. The dispatcher's first write. */
  async create(
    data: Prisma.JobEventUncheckedCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<JobEvent> {
    return tx.jobEvent.create({ data });
  },

  /** Read one event by id — the worker's payload lookup for a claimed run. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<JobEvent | null> {
    return tx.jobEvent.findUnique({ where: { id } });
  },

  /**
   * Events for one workspace, newest first. The operator surface's read.
   * `take` is required rather than defaulted — an unbounded read of an
   * append-only log is a page that gets slower every day.
   */
  async listByWorkspace(
    workspaceId: string,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<JobEvent[]> {
    return tx.jobEvent.findMany({
      where: { workspaceId },
      orderBy: { receivedAt: 'desc' },
      take,
    });
  },

  /** Count the events recorded for one name. A cheap assertion surface for the tests. */
  async countByName(name: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobEvent.count({ where: { name } });
  },
};
