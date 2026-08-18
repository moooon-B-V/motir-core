import type { PlatformAuditLog } from '@/generated/prisma/client';
import type { PlatformAuditLogDTO, PlatformOperatorDTO } from '@/lib/dto/platform';
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
