import type { DispatchRunEvent, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `dispatch_run_event` — the ordered stream (Story
// MOTIR-1789 · MOTIR-1791, ADR `docs/decisions/dispatch-run-record.md`).
//
// `tx` on every method, reads included: the table is RLS-gated on
// `app.workspace_id` (see `dispatchRunRepository`'s header).
//
// ⚠️ EVERY READ ORDERS BY `seq`, NEVER BY `created_at`. Two events written in the
// same millisecond have no order at all under a timestamp, and the SSE stream's
// entire contract is *"give me everything after `seq`"* — an order that
// occasionally disagrees with itself would show a reader an agent exiting before
// it started, intermittently, on a fast machine.

export const dispatchRunEventRepository = {
  /**
   * Append a batch. `tx` required — a write.
   *
   * `skipDuplicates` makes a REDELIVERED batch converge on the rows it already
   * wrote instead of failing the whole append: the unique `(dispatch_run_id,
   * seq)` is the append's idempotency key, and a reporter that retries after a
   * timeout has no way to know whether its first attempt landed. Returning the
   * count lets the caller say how many were actually new.
   */
  async createMany(
    data: Prisma.DispatchRunEventCreateManyInput[],
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.dispatchRunEvent.createMany({ data, skipDuplicates: true });
    return result.count;
  },

  /**
   * THE TAILING READ — everything after `sinceSeq`, in `seq` order.
   *
   * `sinceSeq` is EXCLUSIVE and 0 means "from the beginning", so a client that
   * has seen nothing and a client resuming from event 400 use the same call.
   * `take` bounds one page: a run with an opt-in log body can hold thousands of
   * events, and the stream sends them in chunks rather than one response.
   */
  async listSince(
    dispatchRunId: string,
    sinceSeq: number,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunEvent[]> {
    return tx.dispatchRunEvent.findMany({
      where: { dispatchRunId, seq: { gt: sinceSeq } },
      orderBy: { seq: 'asc' },
      take,
    });
  },

  /** One leg's slice of the stream — the card page's run section. */
  async listByCardSince(
    dispatchRunCardId: string,
    sinceSeq: number,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunEvent[]> {
    return tx.dispatchRunEvent.findMany({
      where: { dispatchRunCardId, seq: { gt: sinceSeq } },
      orderBy: { seq: 'asc' },
      take,
    });
  },

  /**
   * The highest `seq` this run has stored, or `null` for a run with no events.
   *
   * ⚠️ THIS IS THE ALLOCATOR'S INPUT, AND IT IS ONLY SAFE UNDER THE RUN'S ROW
   * LOCK. `dispatchRunService.appendEvents` takes
   * `dispatchRunRepository.findTerminalStateForUpdate` first and numbers from
   * this value; read WITHOUT that lock it hands two concurrent appenders the
   * same number, and the unique index then rejects one of their batches —
   * turning a routine retry into a lost stream. It is also the answer a RESUMING
   * READER wants (how far along is this run), which needs no lock at all: the
   * two callers differ in what they do next, not in what they read.
   */
  async maxSeq(dispatchRunId: string, tx: Prisma.TransactionClient): Promise<number | null> {
    const row = await tx.dispatchRunEvent.aggregate({
      where: { dispatchRunId },
      _max: { seq: true },
    });
    return row._max.seq;
  },

  /**
   * How many events a run holds — the ingest cap's own read (ADR Q4: a run stops
   * accepting events at 5 000 and records that it did).
   */
  /**
   * Has this run already recorded THIS finding? (MOTIR-3981.)
   *
   * ⚠️ THE IDEMPOTENCY GUARD, and it is needed because one finding is reachable
   * from more than one seam: a bug filed with its `relates_to` in the create
   * call and a bug linked afterwards arrive by different paths, and a plan can
   * reach `planned` again after a revision. One finding must be one row.
   *
   * Matched on the id INSIDE `data` rather than on a column, because the
   * identity is the thing found and it differs per kind — `workItemId` for a
   * bug, `planId` for a plan. Both are written by `recordFinding`, so the path
   * is not a guess about somebody else's payload.
   */
  async findFindingOnRun(
    dispatchRunId: string,
    kind: 'bug_filed' | 'plan_submitted',
    findingId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string } | null> {
    const path = kind === 'bug_filed' ? ['workItemId'] : ['planId'];
    return tx.dispatchRunEvent.findFirst({
      where: { dispatchRunId, kind, data: { path, equals: findingId } },
      select: { id: true },
    });
  },

  async countByRun(dispatchRunId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.dispatchRunEvent.count({ where: { dispatchRunId } });
  },

  /**
   * The RETENTION SWEEP's CROSS-TENANT discovery read (MOTIR-1792): which
   * workspaces still hold a log body past the cut-off.
   *
   * ⚠️ RUNS UNDER `withSystemContext`, for the same reason the run reap's
   * discovery does: an expiring body is in whichever tenant happened to opt in,
   * and the sweep cannot bind a workspace it has not learned yet. It returns
   * WORKSPACE IDS and nothing else — the bodies themselves are never read
   * cross-tenant, only counted — and the clearing write then re-binds per
   * workspace.
   */
  async listWorkspacesWithExpiredBodies(
    createdBefore: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<string[]> {
    const rows = await tx.dispatchRunEvent.findMany({
      where: { createdAt: { lt: createdBefore }, body: { not: null } },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
      orderBy: { workspaceId: 'asc' },
      take,
    });
    return rows.map((r) => r.workspaceId);
  },

  /**
   * The RETENTION SWEEP's write (MOTIR-1792): null the opt-in log BODIES older
   * than the cut-off, leaving the events themselves.
   *
   * ⚠️ IT NULLS `body`, IT DOES NOT DELETE ROWS. The lifecycle is the run's
   * memory of what it did and is kept; the body is the only private, unbounded,
   * low-half-life part of it. Deleting the rows would silently renumber nothing
   * — `seq` is stored — but it would put HOLES in a stream whose readers resume
   * by cursor, and a reader that asks for everything after 400 and is handed 500
   * cannot tell a deleted event from one that has not happened yet.
   */
  async clearBodiesOlderThan(createdBefore: Date, tx: Prisma.TransactionClient): Promise<number> {
    const result = await tx.dispatchRunEvent.updateMany({
      where: { createdAt: { lt: createdBefore }, body: { not: null } },
      data: { body: null },
    });
    return result.count;
  },
};
