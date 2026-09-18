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

  /**
   * Delete one event by id. The ONE caller is `replayDLQ`'s already-replayed arm
   * (MOTIR-3730): the replay writes its event BEFORE it can know whether the run
   * it belongs to is a duplicate (the queue row carries the FK), so when the
   * dedup index answers "already enqueued" the event it wrote is a row nothing
   * will ever consume. Removing it inside the same transaction is what makes
   * "already replayed" mean *nothing happened* rather than *nothing happened,
   * except a log row*. The dispatcher's own header states the standing reason
   * this matters: an event nothing consumes is table growth on a request path.
   */
  async deleteById(id: string, tx: Prisma.TransactionClient): Promise<void> {
    await tx.jobEvent.delete({ where: { id } });
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

  /**
   * The NEWEST `work-item/transitioned` event for one work item INTO one status
   * (Story MOTIR-4931 · MOTIR-5709) — the acceptance lane's handle on "the
   * transition I just made", so it can wait on that event's resolve run instead
   * of on a sleep. Reads the event's JSON payload by path.
   */
  async findLatestTransitioned(
    workItemId: string,
    toStatusKey: string,
    tx: Prisma.TransactionClient,
  ): Promise<JobEvent | null> {
    return tx.jobEvent.findFirst({
      where: {
        name: 'work-item/transitioned',
        AND: [
          { data: { path: ['workItemId'], equals: workItemId } },
          { data: { path: ['toStatusKey'], equals: toStatusKey } },
        ],
      },
      orderBy: { receivedAt: 'desc' },
    });
  },

  /** Count the events recorded for one name. A cheap assertion surface for the tests. */
  async countByName(name: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.jobEvent.count({ where: { name } });
  },
};
