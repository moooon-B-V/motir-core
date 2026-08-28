import { type DataExportRequest, type Prisma } from '@/generated/prisma/client';

// Data access for `data_export_request` (Story 8.4 · Subtask MOTIR-3698) — one
// row per request for a copy of everything an account holds (GDPR Art. 15 +
// Art. 20).
//
// Single Prisma operations only; no business logic, no transactions of its own
// (CLAUDE.md § 4-layer). What goes IN the archive, how it is built, when a
// request may be made and when its blob is deleted all belong to the export
// build (MOTIR-3701). This file holds the row.
//
// ⚠️ EVERY METHOD TAKES `tx`, INCLUDING THE READS — the same reason as
// `accountDeletionRequestRepository`: the table is RLS-gated on `app.user_id`,
// that GUC is transaction-local, and a singleton read returns ZERO ROWS while
// raising nothing, so a real archive reads as "you have never asked for one".

/** Opening a request records only who asked and when — every other column is
 *  written by the build. */
export interface CreateDataExportRequestInput {
  userId: string;
  requestedAt: Date;
}

/** What an UPDATE may change: the build's outcome. `userId` and `requestedAt`
 *  are settled at create. */
export interface UpdateDataExportRequestInput {
  status?: DataExportRequest['status'];
  blobPathname?: string | null;
  builtAt?: Date | null;
  expiresAt?: Date | null;
  failureReason?: string | null;
}

export const dataExportRequestRepository = {
  /** Open one request. No uniqueness constraint applies — see the model's doc
   *  comment for why a second archive is wasteful rather than incorrect, and
   *  why the throttle is a service-side rate limit instead of an index. */
  async create(
    input: CreateDataExportRequestInput,
    tx: Prisma.TransactionClient,
  ): Promise<DataExportRequest> {
    return tx.dataExportRequest.create({ data: input });
  },

  /**
   * ONE request by its id, or null — the read the DOWNLOAD route resolves
   * (Story 8.4 · Subtask MOTIR-3703).
   *
   * ⚠️ THE `tx` IS THE AUTHORIZATION, not a transactional nicety. The table's
   * policy (`data_export_request_owner_or_system`) admits a row only when
   * `app.user_id` matches it, so this call under `withUserContext(caller)`
   * cannot see another person's archive — and under no context at all it sees
   * nothing, silently. That is the whole reason every method here takes `tx`,
   * and the reason a caller must never reach for the `db` singleton to "just
   * look up the row".
   */
  async findById(id: string, tx: Prisma.TransactionClient): Promise<DataExportRequest | null> {
    return tx.dataExportRequest.findUnique({ where: { id } });
  },

  /**
   * This user's most recent request, or null — what the pane renders. Newest
   * first by `requestedAt`, tie-broken on `id` so the answer is deterministic
   * when two rows share a millisecond (a retry, or a fixture that pins the
   * clock).
   */
  async findLatestByUserId(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<DataExportRequest | null> {
    return tx.dataExportRequest.findFirst({
      where: { userId },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * This user's most recent request, LOCKED `FOR UPDATE` inside the caller's
   * transaction — the read a build derives its write from.
   *
   * ⚠️ SAME CAVEAT AS THE DELETION REPOSITORY'S LOCK, and it bites harder here
   * because this table carries NO unique index to catch what the lock misses:
   * a `SELECT … FOR UPDATE` matching zero rows locks nothing, so two callers
   * racing a user's FIRST export both see `null` and both insert. That is a
   * duplicate archive, not a corrupted one — nothing is destroyed and the pane
   * shows the newest — which is precisely why this table was left without a
   * constraint (see the model's doc comment). A caller that needs the stronger
   * property must serialise on something that exists, not on this read.
   *
   * `ORDER BY` matches {@link findLatestByUserId} so the row locked is the row
   * that read returns.
   */
  async findLatestByUserIdForUpdate(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ id: string; status: DataExportRequest['status']; builtAt: Date | null } | null> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; status: DataExportRequest['status']; builtAt: Date | null }>
    >`
      SELECT "id", "status", "built_at" AS "builtAt"
        FROM "data_export_request"
       WHERE "user_id" = ${userId}
       ORDER BY "requested_at" DESC, "id" DESC
       LIMIT 1
       FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * Every `ready` archive whose retention window has run out — the expiry
   * sweep's read (Story 8.4 · MOTIR-3701). Both columns are the model's
   * `[status, expiresAt]` index, which exists for this query.
   *
   * `ready` ONLY, deliberately. A `failed` or already-`expired` row has no blob
   * to delete, and a `preparing` one has no `expiresAt` yet — widening this to
   * "past expiry" would sweep rows whose build is still running the moment a
   * null date sorted early.
   *
   * Cross-tenant: the sweep runs under `withSystemContext`, which the table's
   * policy arms for exactly this reader.
   */
  async listExpirable(
    input: { now: Date; take: number },
    tx: Prisma.TransactionClient,
  ): Promise<Array<Pick<DataExportRequest, 'id' | 'userId' | 'blobPathname'>>> {
    return tx.dataExportRequest.findMany({
      where: { status: 'ready', expiresAt: { lte: input.now } },
      select: { id: true, userId: true, blobPathname: true },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: input.take,
    });
  },

  /** Record a build's outcome (ready + its blob, failed + its reason, expired).
   *  Write → `tx` required. Keyed by `id` — the caller has just locked it. */
  async update(
    id: string,
    data: UpdateDataExportRequestInput,
    tx: Prisma.TransactionClient,
  ): Promise<DataExportRequest> {
    return tx.dataExportRequest.update({ where: { id }, data });
  },
};
