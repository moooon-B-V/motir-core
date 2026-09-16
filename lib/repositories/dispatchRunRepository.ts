import type {
  DispatchCommand,
  DispatchRun,
  DispatchRunStatus,
  Prisma,
} from '@/generated/prisma/client';

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
 * One page of a run listing: the cap, the opaque cursor, and — for the reads
 * that offer it — the STATUS narrowing.
 *
 * `startedAt DESC, id DESC` is already a TOTAL order because `id` breaks the
 * tie, which is what makes the cursor safe: two runs opened in the same
 * millisecond cannot straddle a page boundary in an order the next call
 * disagrees with.
 */
export interface DispatchRunPage {
  take: number;
  cursor?: string | undefined;
  /** Omit for every status; a non-empty list narrows the query itself. */
  statuses?: DispatchRunStatus[] | undefined;
}

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

/** An open run and who started it — the holder a refused repair claim names. */
export interface RunningDispatchRunHolder {
  id: string;
  startedAt: Date;
  createdById: string | null;
  /** Null when the operator's account has since been deleted (`SET NULL`). */
  createdBy: { id: string; name: string } | null;
}

export const dispatchRunRepository = {
  /** Open a run. `tx` required — a write. */
  async create(
    data: Prisma.DispatchRunCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRun> {
    return tx.dispatchRun.create({ data });
  },

  /**
   * The id of the newest RUNNING run whose SCOPE TARGET is this work item, or
   * that holds a leg for it, or null — the run a How-to-test record is
   * attributed to (MOTIR-5331). HOW TO TEST is written onto the run target, so a
   * scoped run's close-out publish on its story must resolve to that run even
   * though the story is not one of its legs. Read server-side so an agent is
   * never asked for an id it cannot know.
   */
  async findLatestRunningIdForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string | null> {
    const row = await tx.dispatchRun.findFirst({
      where: {
        status: 'running',
        OR: [{ scopeWorkItemId: workItemId }, { cards: { some: { workItemId } } }],
      },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return row?.id ?? null;
  },

  /**
   * The SCOPE of the newest RUNNING run holding a leg for one work item, or null
   * — how a dispatch prompt learns whether its item is its own run target or one
   * child of a scoped run (MOTIR-5334). A run is opened with its whole plan of
   * legs before its first dispatch, so the leg exists by the time the prompt is
   * asked for. Null when no running run carries the item, or the one that does
   * has no scope.
   */
  async findRunningScopeForWorkItem(
    workItemId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; identifier: string } | null> {
    const row = await tx.dispatchRun.findFirst({
      where: { status: 'running', cards: { some: { workItemId } } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { scope: { select: { id: true, identifier: true } } },
    });
    return row?.scope ?? null;
  },

  /**
   * The newest RUNNING run of one COMMAND that holds a leg for this work item, with
   * the person who started it, or null — the REPAIR claim's lock read (MOTIR-5464).
   *
   * An open `fix` run IS the one-repair-at-a-time lock, so the question is asked
   * of the run table rather than of a column on the card. It is only a lock
   * because the caller holds the CARD's row lock while it asks and while it opens
   * the run that answers the next caller: two claimants serialize on the card, so
   * the second one reads the first one's committed run here.
   */
  async findRunningByCommandForWorkItem(
    workItemId: string,
    command: DispatchCommand,
    tx: Prisma.TransactionClient,
  ): Promise<RunningDispatchRunHolder | null> {
    return tx.dispatchRun.findFirst({
      where: { status: 'running', command, cards: { some: { workItemId } } },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        startedAt: true,
        createdById: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
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
    { take, cursor, statuses }: DispatchRunPage,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards[]> {
    return tx.dispatchRun.findMany({
      where: { scopeWorkItemId, ...(statuses ? { status: { in: statuses } } : {}) },
      include: WITH_CARDS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  },

  /**
   * A project's runs, newest first — the RUNS INDEX's read (MOTIR-3922).
   *
   * ⚠️ THE FILTER IS APPLIED HERE, NOT BY THE CALLER. `statuses` narrows the
   * query rather than the page, because a service that filtered the rows it got
   * back would hand out short pages and, at a page boundary, an empty one with a
   * cursor still to follow — which every client reads as "no more runs".
   */
  async listByProject(
    projectId: string,
    { take, cursor, statuses }: DispatchRunPage,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards[]> {
    return tx.dispatchRun.findMany({
      where: { projectId, ...(statuses ? { status: { in: statuses } } : {}) },
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
   * A project's LIVE runs — the `/ready` strip's ONE read (MOTIR-1793).
   *
   * ⚠️ NOT paginated, and that is the decision rather than an omission. The
   * population is bounded by how many runs one project has IN FLIGHT, which is a
   * handful; the alternative — a per-card *"is there a live run?"* endpoint —
   * is an N+1 acquired on the busiest surface in the product, and the kind that
   * looks fine with three rows.
   */
  async listActiveByProject(
    projectId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DispatchRunWithCards[]> {
    return tx.dispatchRun.findMany({
      where: { projectId, status: 'running' },
      include: WITH_CARDS,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The SWEEP's CROSS-TENANT discovery read (MOTIR-1792): every run still
   * `running` past the cut-off, in ANY workspace, oldest first.
   *
   * ⚠️ IT MUST RUN UNDER `withSystemContext`, and it returns the WHOLE ROW so the
   * caller can read `workspaceId` off it. The abandoned runs a sweep has to close
   * are spread across tenants by construction — one operator's laptop died, and
   * another's did — and the workspace is not known until the first row comes
   * back, so no wrapper could have bound it up front. The `FOR SELECT` system arm
   * (`20260829130000_dispatch_run_system_read`) is what admits this read, and it
   * is READ-ONLY: every write the sweep then makes re-binds to that row's own
   * workspace.
   */
  async listStaleRunningAcrossWorkspaces(
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
