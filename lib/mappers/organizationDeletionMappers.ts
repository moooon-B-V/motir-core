import type { OrganizationDeletionRequest } from '@/generated/prisma/client';
import type { OrganizationDeletionRequestDTO } from '@/lib/dto/organizationDeletion';

// Prisma → DTO for organization deletion (Story MOTIR-6306 · MOTIR-6391).
//
// The sweep's internals — `erasureStep`, `lastError`, `erasingStartedAt`,
// `purgedAt` — are deliberately NOT mapped: they are the sweep's resume cursor
// and an operator's diagnostic, and no surface a member sees renders them.

export function toOrganizationDeletionRequestDTO(
  request: OrganizationDeletionRequest,
): OrganizationDeletionRequestDTO {
  return {
    id: request.id,
    organizationId: request.organizationId,
    status: request.status,
    requestedByUserId: request.requestedByUserId,
    requestedAt: request.requestedAt.toISOString(),
    erasureDueAt: request.erasureDueAt.toISOString(),
    cancelledAt: request.cancelledAt?.toISOString() ?? null,
    cancelledByUserId: request.cancelledByUserId,
    erasedAt: request.erasedAt?.toISOString() ?? null,
  };
}
