import {
  Prisma,
  type PlatformAuditLog,
  type PlatformAuditTargetKind,
} from '@/generated/prisma/client';

/**
 * The platform audit trail — `docs/decisions/platform-staff-auth.md` §3b.
 *
 * ⚠️ APPEND-ONLY, and this file is what makes that true. The table's RLS policy
 * is `FOR ALL` (the four-verb totality guard requires every verb to be covered,
 * and under the non-bypass role an uncovered verb is a CLOSED door rather than
 * an open one — notes.html #248), so the DATABASE does not forbid an UPDATE or
 * a DELETE under a platform context. What forbids them is that this repository
 * exposes `create` and reads and no mutator, and there is no second path to the
 * table. Do NOT add `update`, `delete` or `deleteMany` here: an audit row that
 * can be edited answers "who touched this tenant?" the way the person who
 * touched it would prefer. Tamper-EVIDENCE — the hash chain that would make
 * this structural rather than conventional — is MOTIR-751's (Story 10.3).
 *
 * Every method takes `tx` as a REQUIRED parameter, reads included, which is one
 * step stricter than `CLAUDE.md`'s read-method rule allows. The reason is the
 * policy: the only thing that admits a row is `app.platform_staff`, and the
 * only thing that binds it is `withPlatformRead` (`lib/platform/context.ts`).
 * A read issued on the `db` singleton would return ZERO ROWS AND RAISE NOTHING
 * — the exact silent-denial shape MOTIR-2880 recorded for `withSystemContext`.
 * Requiring `tx` makes that a compile-time error instead.
 */
export const platformAuditLogRepository = {
  /**
   * Append one row. The ONLY write this table has.
   *
   * Called by `withPlatformRead` as the FIRST statement inside the platform
   * transaction, before the work it audits runs — so a read that rolls back
   * leaves no row, and a read that commits cannot exist without one.
   */
  async create(
    data: Prisma.PlatformAuditLogCreateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog> {
    return tx.platformAuditLog.create({ data });
  },

  /**
   * The most recent rows for one actor, newest first. Served by the
   * `(actor_user_id, created_at)` index.
   *
   * The audit-log VIEWER is MOTIR-751's, not this card's; these reads exist so
   * the write path can be asserted end-to-end and so a consumer has a seam to
   * build on rather than reaching for `tx.platformAuditLog` directly.
   */
  async listByActor(
    actorUserId: string,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog[]> {
    return tx.platformAuditLog.findMany({
      where: { actorUserId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /**
   * The most recent rows for ONE TARGET, newest first (MOTIR-1167).
   *
   * Panel 9's "Support actions" log — *"every operator write on this account,
   * newest first, append-only"*. Served by the `(target_kind, target_id,
   * created_at)` index.
   *
   * ⚠️ IT RETURNS READS AS WELL AS WRITES, and the SERVICE decides what the card
   * shows. Keeping the filter out of the repository is the single-op rule doing
   * its job: "which actions count as a write" is the audit vocabulary's
   * knowledge (`PLATFORM_AUDIT_ACTIONS`), not the table's, and a repository that
   * encoded it would have to be edited every time a consumer adds a verb.
   */
  async listByTarget(
    targetKind: PlatformAuditTargetKind,
    targetId: string,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog[]> {
    return tx.platformAuditLog.findMany({
      where: { targetKind, targetId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },

  /** The most recent rows for one organization, newest first. */
  async listByOrganization(
    organizationId: string,
    limit: number,
    tx: Prisma.TransactionClient,
  ): Promise<PlatformAuditLog[]> {
    return tx.platformAuditLog.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  },
};
