import type { StaffSessionDTO } from '@/lib/dto/platformImpersonation';
import type { ImpersonationSessionWithNames } from '@/lib/repositories/impersonationSessionRepository';

/**
 * An `impersonation_session` row (with its names) → the DTO the bar, the ended
 * page and the console render (MOTIR-749). An allow-list: the token hash and the
 * operator's Better-Auth session id never leave the service layer.
 */
export function toStaffSessionDTO(row: ImpersonationSessionWithNames): StaffSessionDTO {
  return {
    id: row.id,
    mode: row.mode,
    operatorUserId: row.operatorUserId,
    targetUserId: row.targetUserId,
    targetName: row.target.name,
    targetEmail: row.target.email,
    organizationId: row.organizationId,
    organizationName: row.organization.name,
    workspaceId: row.workspaceId,
    reason: row.reason,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endedBy: row.endedBy ?? null,
  };
}

/** The first word of a display name — "View as Dana" (design `imp.viewAs`). */
export function firstNameOf(name: string, email: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : (email.split('@')[0] ?? email);
}
