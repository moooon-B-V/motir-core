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
   * ⚠️ THIS IS NOT A SEQUENCE ALLOCATOR, and must not be used as one. The
   * reporter numbers its own events — it is the only party that knows the order
   * they happened in — and the unique index is what refuses a collision. Reading
   * the max and adding one would hand two concurrent appenders the same number
   * and lose one of their events to `skipDuplicates`, silently. What this
   * answers is the different question a RESUMING reader asks: how far along is
   * this run's stream right now.
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
  async countByRun(dispatchRunId: string, tx: Prisma.TransactionClient): Promise<number> {
    return tx.dispatchRunEvent.count({ where: { dispatchRunId } });
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
