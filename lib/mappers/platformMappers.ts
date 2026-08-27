import type { PlatformAuditLog, User } from '@/generated/prisma/client';
import type {
  PlatformAuditLogDTO,
  PlatformOperatorDTO,
  PlatformUserDetailDTO,
  PlatformUserSummaryDTO,
} from '@/lib/dto/platform';
import type { PlatformPrincipal } from '@/lib/platform/auth';

/** A `platform_audit_log` row → the DTO. */
export function toPlatformAuditLogDTO(row: PlatformAuditLog): PlatformAuditLogDTO {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    action: row.action,
    targetKind: row.targetKind,
    targetId: row.targetId,
    targetLabel: row.targetLabel,
    organizationId: row.organizationId,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The acting principal → what a page may render.
 *
 * Drops `userId` deliberately. The console footer draws an email and a role;
 * handing a client component the id of the acting operator adds nothing it
 * renders and one more thing that can end up in markup.
 */
export function toPlatformOperatorDTO(principal: PlatformPrincipal): PlatformOperatorDTO {
  return { email: principal.email, role: principal.role };
}

/**
 * A `user` row → the operator LOOKUP's row (MOTIR-1167).
 *
 * ⚠️ AN ALLOW-LIST, NOT A SPREAD-AND-DELETE. Every field is named, so a column
 * added to `user` later — a phone number, a locale, a billing id — does NOT
 * silently appear on a cross-tenant operator surface because a mapper forwarded
 * whatever it was handed. That is the same argument `platformStaffRepository`
 * makes for its three-column `select`, one layer up.
 */
export function toPlatformUserSummaryDTO(row: User): PlatformUserSummaryDTO {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
  };
}

/** A `user` row + its session count → the operator DRILL-DOWN's account. */
export function toPlatformUserDetailDTO(
  row: User,
  activeSessionCount: number,
): PlatformUserDetailDTO {
  return {
    ...toPlatformUserSummaryDTO(row),
    emailVerified: row.emailVerified,
    twoFactorEnabled: row.twoFactorEnabled,
    suspendedReason: row.suspendedReason,
    activeSessionCount,
    platformRole: row.platformRole,
  };
}
