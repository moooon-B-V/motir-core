import type { DispatchRun, Prisma } from '@/generated/prisma/client';

// Single Prisma operations on `dispatch_run` — the HEADER of one CLI invocation
// (Story MOTIR-1789 · MOTIR-1791, ADR `docs/decisions/dispatch-run-record.md`).
//
// ⚠️ EVERY METHOD HERE TAKES `tx`, READS INCLUDED, and that is a deliberate
// departure from the "reads may use the `db` singleton" half of the layer rule —
// the same departure `workItemDeliveryRepository` and `workItemRepoRepository`
// make, for the same reason. Every row is gated by an RLS policy on
// `app.workspace_id`, a GUC bound by `withWorkspaceContext` on a TRANSACTION and
// by nothing else. A read through the bare singleton does not fail: it returns
// an EMPTY LIST, indistinguishable from "this project has never been run", which
// is by a wide margin the worse of the two failures. Requiring `tx` turns it
// into a type error at the call site.
//
// No business logic, no transactions, no DTO mapping — `dispatchRunService`
// (MOTIR-1792) composes these.

/** A run WITH its legs, in the run's own stored order — the read `/runs/[id]`
 *  and the ingest's own close-out both need, without a second round trip. */
export type DispatchRunWithCards = Prisma.DispatchRunGetPayload<{
  include: { cards: true };
}>;

const WITH_CARDS = { cards: { orderBy: { position: 'asc' } } } as const;

/**
 * The terminal columns, read under a row lock.
 *
 * A bare row type rather than the Prisma model, because the guard's whole job is
 * to answer ONE question — is this run already closed? — and a caller handed the
 * whole row starts deriving other things from a snapshot it only holds for the
 * length of one transaction.
 */
export interface LockedDispatchRunTerminalState {
  id: string;
  status: DispatchRun['status'];
  stopReason: DispatchRun['stopReason'];
  endedAt: Date | null;
}

export const dispatchRunRepository = {
  /** Open a run. `tx` required — a write. */
  async create(
    data: Prisma.DispatchRunCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun> {
    return tx.dispatchRun.create({ data });
  },

  /** One run WITH its legs, in stored `position` order. */
  async findByIdWithCards(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards | null> {
    return tx.dispatchRun.findUnique({ where: { id }, include: WITH_CARDS });
  },

  /** One run, header only — the cheap read the append path makes per batch. */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<DispatchRun | null> {
    return tx.dispatchRun.findUnique({ where: { id } });
  },

  /**
   * The IDEMPOTENT open: the run this workspace already has under this key.
   *
   * The unique index `(workspace_id, idempotency_key)` is what makes a retried
   * open one row rather than two runs that each saw half the work; this is the
   * read that turns the second call into a no-op instead of a constraint error.
   */
  async findByIdempotencyKey(
    workspaceId: string,
    idempotencyKey: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun | null> {
    return tx.dispatchRun.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId, idempotencyKey } },
    });
  },

  /**
   * ONE CARD'S RUN HISTORY — every run that owned a leg naming it, newest first.
   *
   * ⚠️ CURSOR-PAGINATED, because run history is UNBOUNDED. A card worked by
   * `motir auto` every night accumulates a run per night for as long as the
   * project lives, and the card page's run section renders a page of them.
   *
   * The `some` filter reads through the LEG rather than a column on the run: a
   * run owns a set of cards, so "runs for this card" is a question about the
   * legs and there is no denormalized answer to keep in sync.
   */
  async listByWorkItem(
    workItemId: string,
    { take, cursor }: { take: number; cursor?: string | undefined },
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards[]> {
    return tx.dispatchRun.findMany({
      where: { cards: { some: { workItemId } } },
      include: WITH_CARDS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * Runs pointed AT one container as their scope — the story's own run history.
   *
   * A different question from {@link listByWorkItem} and not a special case of
   * it: a scoped run's legs are the container's CHILDREN, so the container
   * itself has no leg and would not appear in its own card history.
   */
  async listByScope(
    scopeWorkItemId: string,
    { take, cursor }: { take: number; cursor?: string | undefined },
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards[]> {
    return tx.dispatchRun.findMany({
      where: { scopeWorkItemId },
      include: WITH_CARDS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /** A project's runs, newest first — the run list and the `/ready` strip's read. */
  async listByProject(
    projectId: string,
    { take, cursor }: { take: number; cursor?: string | undefined },
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards[]> {
    return tx.dispatchRun.findMany({
      where: { projectId },
      include: WITH_CARDS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * The run's terminal columns, LOCKED `FOR UPDATE` inside the caller's
   * transaction — the read-derived guard every close derives from
   * (lock-before-a-read-derived-update, `CLAUDE.md` § concurrency).
   *
   * ⚠️ WHY A CLOSE NEEDS A LOCK AT ALL. Two things race to close one run: the
   * CLI's own `run_closed` report, and the abandoned-run reap that decided
   * nothing was holding it. Without the lock both read `running`, both write,
   * and the loser's write LANDS — so a run that finished cleanly can end up
   * recorded as `timed_out`, which is the one outcome a reader would take as
   * evidence that something went wrong. With it, the second writer re-reads a
   * row that is already terminal and returns without writing.
   *
   * `tx` REQUIRED: a row lock lives only for its transaction, so a caller
   * without one would take the lock and drop it on the next statement.
   */
  async findTerminalStateForUpdate(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<LockedDispatchRunTerminalState | null> {
    const rows = await tx.$queryRaw<LockedDispatchRunTerminalState[]>`
      SELECT "id",
             "status",
             "stop_reason" AS "stopReason",
             "ended_at"    AS "endedAt"
        FROM "dispatch_run"
       WHERE "id" = ${id}
       FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /** Close a run. `tx` required — a write, and one the guard above must precede. */
  async update(
    id: string,
    data: Prisma.DispatchRunUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun> {
    return tx.dispatchRun.update({ where: { id }, data });
  },

  /**
   * The ABANDONED-RUN REAP's discovery read (MOTIR-1792): runs still `running`
   * that started before a cut-off, oldest first.
   *
   * Status-first ordering matches the `(status, started_at)` index, and `running`
   * is a tiny minority of the table — the same shape `job_run`'s reap read has.
   */
  async listStaleRunning(
    startedBefore: Date,
    take: number,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun[]> {
    return tx.dispatchRun.findMany({
      where: { status: 'running', startedAt: { lt: startedBefore } },
      orderBy: { startedAt: 'asc' },
      take,
    });
  },
};
