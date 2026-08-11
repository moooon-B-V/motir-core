import type { HomeWorkItemRow } from '@/lib/repositories/workItemRepository';
import type { HomeWorkItemRowDto } from '@/lib/dto/home';

// Prisma → DTO converters for the Home domain (Story MOTIR-2649 · Subtask
// MOTIR-2651). `homeService` calls these just before returning, so no Prisma row
// shape (Date objects, Decimal story points) crosses the API boundary.

/**
 * One personal-read row → its DTO.
 *
 * `viewerId` is threaded in because the two relation flags are a fact about the
 * ROW AND THE READER TOGETHER, not about the row: the same item is
 * "Assigned" to one person and "Reported" by another. Resolving them here — at
 * the single place a row becomes a DTO — is what keeps the merged read honest:
 * the query returns one row for an item the reader both owns and filed, and this
 * is where that one row gets to say both things.
 *
 * `storyPoints` is a Prisma `Decimal` (0.5 increments roll up without float
 * drift) and is narrowed to a plain number for the wire, matching
 * `toWorkItemListItemDto`.
 */
export function toHomeWorkItemRowDto(row: HomeWorkItemRow, viewerId: string): HomeWorkItemRowDto {
  return {
    id: row.id,
    kind: row.kind,
    type: row.type,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    reporterId: row.reporterId,
    executor: row.executor,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    estimateMinutes: row.estimateMinutes,
    updatedAt: row.updatedAt.toISOString(),
    project: {
      id: row.project.id,
      identifier: row.project.identifier,
      name: row.project.name,
    },
    viewerIsAssignee: row.assigneeId === viewerId,
    viewerIsReporter: row.reporterId === viewerId,
  };
}
