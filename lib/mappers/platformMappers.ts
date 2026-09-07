import type { Organization, PlatformAuditLog, User } from '@/generated/prisma/client';
import type {
  PlatformAuditLogDTO,
  PlatformOperatorDTO,
  PlatformOrganizationDetailDTO,
  PlatformOrganizationSummaryDTO,
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

/**
 * An `organization` row → the operator LOOKUP's row (MOTIR-4565).
 *
 * ⚠️ AN ALLOW-LIST, NOT A SPREAD-AND-DELETE — the same rule
 * `toPlatformUserSummaryDTO` states and for a sharper reason: `organization`
 * carries BILLING state (`scaledTrackerSubscription`, the tier mirror), so a
 * mapper that forwarded whatever it was handed would put a future billing column
 * on a cross-tenant operator surface the moment somebody added one.
 */
export function toPlatformOrganizationSummaryDTO(
  row: Organization,
): PlatformOrganizationSummaryDTO {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: row.createdAt.toISOString(),
    isMeta: row.isMeta,
    internalBilling: row.internalBilling,
  };
}

/** An `organization` row → the operator ORG PAGE's organization. */
export function toPlatformOrganizationDetailDTO(row: Organization): PlatformOrganizationDetailDTO {
  return {
    ...toPlatformOrganizationSummaryDTO(row),
    aiIncludedSeat: row.aiIncludedSeat,
    // The COLUMN is a Json blob of Stripe-propagated state; the page needs only
    // whether one is on record, and forwarding the blob would put a payment
    // provider's payload on an operator screen for no rendered benefit.
    hasScaledTrackerSubscription: row.scaledTrackerSubscription !== null,
  };
}
