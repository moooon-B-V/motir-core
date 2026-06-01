import type { WorkItem } from '@prisma/client';
import type { WorkItemSubtreeRow } from '@/lib/repositories/workItemRepository';
import type { WorkItemDto, WorkItemSummaryDto, WorkItemSubtreeDto } from '@/lib/dto/workItems';

// Prisma → DTO converters for the work-item domain. The service calls these
// just before returning so no Prisma row shape (Date objects, Decimal
// instances, Prisma enums) leaks across the API boundary. Mirrors the shape
// of lib/mappers/projectMappers.ts.

/**
 * Full detail-view DTO. The nullable dates are normalized to wire-safe ISO
 * strings here; `position` is already a fractional-index string on the row.
 */
export function toWorkItemDto(row: WorkItem): WorkItemDto {
  return {
    id: row.id,
    projectId: row.projectId,
    parentId: row.parentId,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    descriptionMd: row.descriptionMd,
    explanationMd: row.explanationMd,
    explanationSource: row.explanationSource,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    reporterId: row.reporterId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    position: row.position,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Lighter list/tree-row DTO — omits the two Markdown `@db.Text` content
 * fields so list queries don't ship them per row.
 */
export function toWorkItemSummaryDto(row: WorkItem): WorkItemSummaryDto {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    position: row.position,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
  };
}

/**
 * Subtree-row DTO (Subtask 1.4.4). Maps the recursive-CTE projection
 * (WorkItemSubtreeRow — already plain scalars: `kind` cast to text,
 * `position` a text column, `depth` an int) straight through. No date
 * normalization needed; the projection carries no Date columns. Kept
 * separate from toWorkItemSummaryDto because the source row is the tree-walk
 * shape, not a full WorkItem.
 */
export function toWorkItemSubtreeDto(row: WorkItemSubtreeRow): WorkItemSubtreeDto {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    position: row.position,
    depth: row.depth,
  };
}
