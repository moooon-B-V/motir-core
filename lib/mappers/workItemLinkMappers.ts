import type { WorkItemLink } from '@prisma/client';
import type { WorkItemLinkDto } from '@/lib/dto/workItemLinks';

// Prisma → DTO converter for the work-item-link domain (Subtask 1.4.3). The
// service calls this just before returning so no Prisma row shape (Date
// objects, the Prisma enum) leaks across the API boundary. Mirrors the
// shape of lib/mappers/workItemMappers.ts.
//
// `workspaceId` is deliberately dropped on the mapper boundary — see the
// DTO module for the rationale.

export function toWorkItemLinkDto(row: WorkItemLink): WorkItemLinkDto {
  return {
    id: row.id,
    fromId: row.fromId,
    toId: row.toId,
    kind: row.kind,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
  };
}
