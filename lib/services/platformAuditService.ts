import 'server-only';

import { type PlatformAuditLogDTO } from '@/lib/dto/platform';
import { toPlatformAuditLogDTO } from '@/lib/mappers/platformMappers';
import { reasonPolicyFor, reasonSatisfied } from '@/lib/platform/auditActions';
import { type PlatformPrincipal } from '@/lib/platform/auth';
import { withPlatformRead, type PlatformAuditEntry } from '@/lib/platform/context';
import { MissingAuditReasonError } from '@/lib/platform/errors';
import { platformAuditLogRepository } from '@/lib/repositories/platformAuditLogRepository';

/**
 * The platform audit trail's business layer — `docs/decisions/platform-staff-auth.md` §3b.
 *
 * Thin by design. The audit APPEND is not a service-orchestrated write with a
 * transaction of its own: it is the first statement inside every platform
 * transaction, issued by `withPlatformRead`, and this service exists for the
 * one rule the ADR explicitly located above the column — *"REQUIRED for every
 * write action, NULL for a read. Enforced in the service, not by the column,
 * because reads legitimately have none."*
 *
 * MOTIR-2896 ships the write path and these reads. It ships no cross-tenant
 * READ of tenant data (MOTIR-730) and no audit-log VIEWER (MOTIR-751).
 */
export const platformAuditService = {
  /**
   * Record one platform action, with nothing else inside the transaction.
   *
   * The shape a caller uses when the audited thing is the ACTION ITSELF — the
   * console being opened. A caller that audits a READ passes the same entry to
   * `withPlatformRead` and does its reading inside, so the row and the read
   * share one transaction and one fate.
   *
   * @throws MissingAuditReasonError when the action's reason policy is
   *   `required` and no non-blank reason was supplied.
   */
  async record(principal: PlatformPrincipal, entry: PlatformAuditEntry): Promise<void> {
    assertReasonSatisfied(entry);
    await withPlatformRead(principal, entry, async () => undefined);
  },

  /** The most recent actions by one operator, newest first. */
  async listByActor(
    principal: PlatformPrincipal,
    actorUserId: string,
    limit = 50,
  ): Promise<PlatformAuditLogDTO[]> {
    const rows = await withPlatformRead(
      principal,
      { action: 'estate.read', targetKind: 'user', targetId: actorUserId },
      (tx) => platformAuditLogRepository.listByActor(actorUserId, limit, tx),
    );
    return rows.map(toPlatformAuditLogDTO);
  },
};

/**
 * The reason rule, applied to one entry. Composes the pure `reasonSatisfied`
 * (which is where both arms are tested — no action in this build is `required`)
 * with the action's own policy.
 */
export function assertReasonSatisfied(entry: PlatformAuditEntry): void {
  if (!reasonSatisfied(reasonPolicyFor(entry.action), entry.reason)) {
    throw new MissingAuditReasonError(entry.action);
  }
}
