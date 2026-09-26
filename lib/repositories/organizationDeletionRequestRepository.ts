import { type OrganizationDeletionRequest, type Prisma } from '@/generated/prisma/client';

// Data access for `organization_deletion_request` (Story MOTIR-6306 · Subtask
// MOTIR-6391) — one row per request to delete an organization. The org-tier
// sibling of `accountDeletionRequestRepository`, mirrored one for one; its
// comments carry the long form of every rule stated briefly here.
//
// Single Prisma operations only; no business logic, no transactions of its own
// (CLAUDE.md § 4-layer). The POLICY — who may schedule, what cancel restores, the
// erasure order — belongs to the services on top: MOTIR-6399 (schedule / cancel),
// MOTIR-6400 (the erasure sweep), MOTIR-6401 (the retention purge).
//
// ⚠️ EVERY METHOD TAKES `tx`, INCLUDING THE READS. The table is RLS-gated on
// `app.organization_id` (and `app.system_admin` for the sweeps), GUCs that only a
// `withOrgContext` / `withSystemContext` TRANSACTION binds. A read on the `db`
// singleton sees NULL and returns ZERO ROWS while raising nothing — which on this
// surface reads as *"this organization is not being deleted"*.

/** The fields a caller supplies when scheduling. `erasureDueAt` is COMPUTED by
 *  `lib/organizations/deletion.ts`, never typed. */
export interface CreateOrganizationDeletionRequestInput {
  organizationId: string;
  requestedByUserId: string;
  requestedAt: Date;
  erasureDueAt: Date;
}

/** What an UPDATE may change. `organizationId`, `requestedAt` and `erasureDueAt`
 *  are settled at create: moving them would move a date every member has
 *  already been emailed. */
export interface UpdateOrganizationDeletionRequestInput {
  status?: OrganizationDeletionRequest['status'];
  cancelledAt?: Date | null;
  cancelledByUserId?: string | null;
  erasingStartedAt?: Date | null;
  erasedAt?: Date | null;
  purgedAt?: Date | null;
  erasureStep?: OrganizationDeletionRequest['erasureStep'];
  lastError?: string | null;
}

/** The row the locking read hands back — `status` included, read UNDER the lock. */
export interface LockedOrganizationDeletionRequest {
  id: string;
  status: OrganizationDeletionRequest['status'];
  requestedAt: Date;
  erasureDueAt: Date;
  erasureStep: OrganizationDeletionRequest['erasureStep'];
}

export const organizationDeletionRequestRepository = {
  /**
   * Schedule one deletion.
   *
   * ⚠️ THE UNIQUE VIOLATION IS THE GUARD, AND IT IS THE CALLER'S TO TRANSLATE.
   * `organization_deletion_request_open_per_org_key` is a PARTIAL unique index on
   * `(organization_id) WHERE status IN ('scheduled','erasing')`, so a second
   * concurrent insert for an org that already has an open request throws a raw
   * Prisma **`P2002`**. That is what makes scheduling race-safe at all, because
   * {@link findOpenByOrganizationIdForUpdate} can only lock a row that already
   * exists. The service catches the `P2002` OUTSIDE its transaction and rethrows
   * its typed error.
   */
  async create(
    input: CreateOrganizationDeletionRequestInput,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationDeletionRequest> {
    return tx.organizationDeletionRequest.create({ data: input });
  },

  /**
   * This org's MOST RECENT request whatever its status, LOCKED `FOR UPDATE` —
   * the read every cancel, every sweep claim and every schedule guard derives
   * from (lock-before-read-derived-update).
   *
   * ⚠️ ITS PREDICATE IS `organization_id` ALONE, NOT `status`, and the status is
   * READ UNDER THE LOCK. Under READ COMMITTED a `SELECT … FOR UPDATE` that WAITS
   * on a concurrent writer re-evaluates its WHERE against the row version that
   * writer left behind. A status filter would therefore hand the loser of a
   * cancel-vs-sweep race ZERO rows — *"nothing is scheduled"* — for an org the
   * winner just started erasing. `organization_id` is immutable, so the loser is
   * handed the row WITH its new status and can say which answer applies (the
   * `accountDeletionRequestRepository.findLatestByUserIdForUpdate` shape).
   *
   * Callers treat a row whose status is `scheduled` or `erasing` as OPEN; any
   * other status (or `null`) means there is no open request.
   *
   * It does NOT serialise the FIRST schedule: over zero rows `FOR UPDATE` locks
   * nothing. The partial unique index is the guard there ({@link create}).
   *
   * `ORDER BY requested_at DESC, id DESC LIMIT 1` — the newest, deterministically,
   * and the lock stays on the one row the caller is about to write.
   */
  async findOpenByOrganizationIdForUpdate(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<LockedOrganizationDeletionRequest | null> {
    const rows = await tx.$queryRaw<LockedOrganizationDeletionRequest[]>`
      SELECT "id",
             "status",
             "requested_at"   AS "requestedAt",
             "erasure_due_at" AS "erasureDueAt",
             "erasure_step"   AS "erasureStep"
        FROM "organization_deletion_request"
       WHERE "organization_id" = ${organizationId}
       ORDER BY "requested_at" DESC, "id" DESC
       LIMIT 1
       FOR UPDATE
    `;
    return rows[0] ?? null;
  },

  /**
   * This org's OPEN request (`scheduled` or `erasing`), unlocked — the read the
   * settings page and the banner render from. `findFirst`, because the one-open
   * constraint is a PARTIAL unique index Prisma cannot model.
   */
  async findOpenByOrganizationId(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationDeletionRequest | null> {
    return tx.organizationDeletionRequest.findFirst({
      where: { organizationId, status: { in: ['scheduled', 'erasing'] } },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /**
   * The ERASURE SWEEP's work set (MOTIR-6400): every request it has something to
   * do for, oldest deadline first.
   *
   *   * `scheduled` and past its deadline — the ordinary due set, served by the
   *     `(status, erasure_due_at)` index.
   *   * `erasing` — a claimed erasure an earlier run did not finish. Its
   *     `erasureStep` says where to resume, and without this arm a crash
   *     mid-erasure would strand the org half-deleted for ever.
   *
   * System-context only in practice (the sweep binds `app.system_admin`).
   * `limit` bounds one tick; the residue is the next tick's.
   */
  async listDue(
    now: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationDeletionRequest[]> {
    return tx.organizationDeletionRequest.findMany({
      where: {
        OR: [{ status: 'scheduled', erasureDueAt: { lte: now } }, { status: 'erasing' }],
      },
      orderBy: [{ erasureDueAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /**
   * The RETENTION PURGE's work set (MOTIR-6401): every `erased` request whose
   * erasure happened strictly before `cutoff` — i.e. whose seven-year retention
   * has run out (`lib/organizations/deletion.ts` `retentionCutoff`).
   */
  async listErasedBefore(
    cutoff: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationDeletionRequest[]> {
    return tx.organizationDeletionRequest.findMany({
      where: { status: 'erased', erasedAt: { lt: cutoff } },
      orderBy: [{ erasedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /**
   * The REMINDER job's read (MOTIR-6395): every `scheduled` request falling due
   * at or before `until`, soonest first. Cancelled requests do not match — that
   * is how a cancel stops its reminders, with nothing queued to un-queue.
   */
  async listScheduledDueBy(
    until: Date,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationDeletionRequest[]> {
    return tx.organizationDeletionRequest.findMany({
      where: { status: 'scheduled', erasureDueAt: { lte: until } },
      orderBy: [{ erasureDueAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  },

  /** Remove every deletion request of an organization — the retention purge's
   *  (MOTIR-6401), which must clear them before the org row because the FK is
   *  `Restrict`. Their notices cascade. Write → `tx` required. */
  async deleteAllByOrganization(
    organizationId: string,
    tx: Prisma.TransactionClient,
  ): Promise<number> {
    const result = await tx.organizationDeletionRequest.deleteMany({ where: { organizationId } });
    return result.count;
  },

  /** One request by id, or null. */
  async findById(
    id: string,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationDeletionRequest | null> {
    return tx.organizationDeletionRequest.findUnique({ where: { id } });
  },

  /** Move one request along its lifecycle. Keyed by `id` — the caller has just
   *  locked that row. Write → `tx` required. */
  async update(
    id: string,
    data: UpdateOrganizationDeletionRequestInput,
    tx: Prisma.TransactionClient,
  ): Promise<OrganizationDeletionRequest> {
    return tx.organizationDeletionRequest.update({ where: { id }, data });
  },
};
