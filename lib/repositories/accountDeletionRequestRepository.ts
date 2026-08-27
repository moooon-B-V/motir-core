import { type AccountDeletionRequest, type Prisma } from '@/generated/prisma/client';

// Data access for `account_deletion_request` (Story 8.4 · Subtask MOTIR-3698) —
// one row per request to close and erase an account (GDPR Art. 17).
//
// Single Prisma operations only; no business logic, no transactions of its own
// (CLAUDE.md § 4-layer). The POLICY — when a request may be opened, what
// cancelling means, what the erasure sweep does — belongs to the services that
// land on top of this (MOTIR-3700 schedule/cancel, MOTIR-3702 the sweep).
// Nothing in this file knows what a grace period is.
//
// ⚠️ EVERY METHOD TAKES `tx`, INCLUDING THE READS, and that is not the default
// pattern `CLAUDE.md` allows for a pure read. This table is RLS-gated on
// `app.user_id`, and that GUC is bound by `withUserContext` / `withSystemContext`,
// which are TRANSACTIONS. A read on the `db` singleton runs with no GUC bound,
// the policy's predicate is NULL, and it returns ZERO ROWS while raising
// nothing: the denial reads as *"this person has scheduled nothing"*, which on
// this surface means telling somebody their account is not being erased when it
// is. Requiring the client makes that unrepresentable rather than merely
// documented (the `legalAcceptanceRepository` precedent).

/** The fields a caller supplies when opening a request. The deadline is
 *  COMPUTED by `lib/users/dataSubjectRequests.ts`, never typed — see that
 *  module's doc comment on why the window is a published promise. */
export interface CreateAccountDeletionRequestInput {
  userId: string;
  requestedAt: Date;
  erasureDueAt: Date;
}

/** What an UPDATE may change. Deliberately narrow: `userId`, `requestedAt` and
 *  `erasureDueAt` are settled at create and moving them would move a deadline
 *  the reader has already been shown. */
export interface UpdateAccountDeletionRequestInput {
  status?: AccountDeletionRequest['status'];
  cancelledAt?: Date | null;
  completedAt?: Date | null;
}

export const accountDeletionRequestRepository = {
  /**
   * Open one request.
   *
   * ⚠️ THE UNIQUE VIOLATION IS THE GUARD, AND IT IS THE CALLER'S TO TRANSLATE.
   * `account_deletion_request_open_per_user_key` is a PARTIAL unique index on
   * `(user_id) WHERE status = 'scheduled'`, so a second concurrent insert for a
   * user who already has an open request throws a raw Prisma **`P2002`**. That
   * is not a fallback for a missing check — it is what makes scheduling
   * race-safe at all, because {@link findOpenByUserIdForUpdate} can only lock a
   * row that already exists (see its own comment). The service must catch the
   * `P2002` OUTSIDE the transaction and rethrow the same typed domain error its
   * in-transaction lock raises; untranslated it reaches the caller as an
   * unexplained 500.
   */
  async create(
    input: CreateAccountDeletionRequestInput,
    tx: Prisma.TransactionClient,
  ): Promise<AccountDeletionRequest> {
    return tx.accountDeletionRequest.create({ data: input });
  },

  /**
   * This user's OPEN request, or null — the read the pane renders at rest and
   * the read the erasure sweep confirms against.
   *
   * `findFirst` rather than `findUnique`: the "one open request per user"
   * constraint is a PARTIAL unique index, which Prisma cannot model (it has no
   * partial-index modelling), so the type system offers no unique lookup for it
   * even though the database enforces exactly one row.
   */
  async findOpenByUserId(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<AccountDeletionRequest | null> {
    return tx.accountDeletionRequest.findFirst({
      where: { userId, status: 'scheduled' },
    });
  },

  /**
   * This user's OPEN request, LOCKED `FOR UPDATE` inside the caller's
   * transaction — the race-safe read every cancel and every completion derives
   * from (lock-before-read-derived-update, CLAUDE.md § 4-layer).
   *
   * ⚠️ WHAT THIS LOCK DOES AND DOES NOT DO. It serialises writers against a row
   * that ALREADY EXISTS: two cancels, or a cancel racing the erasure sweep, are
   * ordered by it and the loser re-reads a row whose status has already moved.
   * It does NOT serialise the FIRST request, because a `SELECT … FOR UPDATE`
   * over a predicate matching zero rows locks NOTHING — every racer falls
   * through the guard together and inserts. The partial unique index is the
   * guard on that path ({@link create}), and reading this method's `null` as
   * "nobody else can be scheduling right now" is the specific mistake the two
   * comments exist to prevent.
   *
   * `ORDER BY "id"` pins a deterministic lock-acquisition order so two callers
   * that somehow see more than one open row for a user cannot deadlock (the
   * `twoFactorRepository.findByUserIdForUpdate` precedent).
   *
   * `tx` REQUIRED: a row lock lives only for its transaction, so a caller
   * without one would take a lock and drop it on the next statement.
   */
  async findOpenByUserIdForUpdate(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; erasureDueAt: Date; requestedAt: Date } | null> {
    const rows = await tx.$queryRaw<Array<{ id: string; erasureDueAt: Date; requestedAt: Date }>>`
      SELECT "id", "erasure_due_at" AS "erasureDueAt", "requested_at" AS "requestedAt"
        FROM "account_deletion_request"
       WHERE "user_id" = ${userId}
         AND "status" = 'scheduled'
       ORDER BY "id"
       FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * This user's MOST RECENT request whatever its status, LOCKED `FOR UPDATE` —
   * the read the CANCEL path derives from (MOTIR-3700).
   *
   * ⚠️ WHY A SECOND LOCKING READ, AND WHY ITS PREDICATE IS `user_id` ALONE.
   * {@link findOpenByUserIdForUpdate} filters on `status = 'scheduled'`, and
   * under READ COMMITTED a `SELECT … FOR UPDATE` that WAITS on a concurrent
   * writer re-evaluates its WHERE against the row version that writer left
   * behind. So when two cancels race, the loser's status filter no longer
   * matches the row it just waited for and the statement returns ZERO rows —
   * *"you have nothing scheduled"*, which is indistinguishable from a reader
   * who never asked, and which is exactly the sentence a cancel must not
   * produce for somebody whose erasure has already COMPLETED.
   *
   * `user_id` is immutable, so this predicate cannot be falsified by the winner:
   * the loser is handed the row WITH its new status and can say which of the
   * three terminal answers applies. That is the whole reason the cancel path
   * does not reuse the open-only read.
   *
   * `ORDER BY "requested_at" DESC, "id" DESC` picks the newest deterministically
   * (`id` breaks a same-millisecond tie), and `LIMIT 1` keeps the lock to the one
   * row the caller is about to write. History rows below it are nobody's to
   * serialise on — a `cancelled` request is terminal and never moves again.
   *
   * `tx` REQUIRED: a row lock lives only for its transaction.
   */
  async findLatestByUserIdForUpdate(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{
    id: string;
    status: AccountDeletionRequest['status'];
    erasureDueAt: Date;
    requestedAt: Date;
  } | null> {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: AccountDeletionRequest['status'];
        erasureDueAt: Date;
        requestedAt: Date;
      }>
    >`
      SELECT "id",
             "status",
             "erasure_due_at" AS "erasureDueAt",
             "requested_at"   AS "requestedAt"
        FROM "account_deletion_request"
       WHERE "user_id" = ${userId}
       ORDER BY "requested_at" DESC, "id" DESC
       LIMIT 1
       FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /** Move one request to a terminal state (cancelled / completed). Write → `tx`
   *  required. Keyed by `id` — the caller has just locked that row. */
  async update(
    id: string,
    data: UpdateAccountDeletionRequestInput,
    tx: Prisma.TransactionClient,
  ): Promise<AccountDeletionRequest> {
    return tx.accountDeletionRequest.update({ where: { id }, data });
  },
};
