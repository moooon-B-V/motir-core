import type { WorkItem } from '@prisma/client';
import type {
  WorkItemForestRow,
  WorkItemListRow,
  WorkItemSubtreeRow,
  WorkItemTreeRow,
} from '@/lib/repositories/workItemRepository';
import type {
  WorkItemDto,
  WorkItemListItemDto,
  WorkItemSummaryDto,
  WorkItemSubtreeDto,
  WorkItemTreeNodeDto,
  WorkItemTreeRowDto,
} from '@/lib/dto/workItems';

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

/**
 * Tree-node DTO (Subtask 2.5.1). Maps one `findProjectForest` projection row
 * (already plain scalars — `kind` cast to text, `matched`/`assigneeId` direct
 * columns) plus its ALREADY-BUILT `children` array into a `WorkItemTreeNodeDto`.
 * The nesting / sibling-ordering / ancestor-retention pruning are the service's
 * tree work (workItemsService.getProjectTree); this mapper just shapes a single
 * node and keeps `hasChildren` consistent with the children it was handed.
 * `dueDate` is the projection's one Date column — normalized to a wire-safe
 * ISO string here (matching `toWorkItemDto`).
 */
export function toWorkItemTreeNodeDto(
  row: WorkItemForestRow,
  children: WorkItemTreeNodeDto[],
): WorkItemTreeNodeDto {
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
    reporterId: row.reporterId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    depth: row.depth,
    hasChildren: children.length > 0,
    matched: row.matched,
    children,
  };
}

/**
 * Flat List-item DTO (Subtask 2.5.8). Maps one `findProjectIssuesFlat`
 * projection row (already plain scalars — `kind`/`priority` cast to text) into
 * a `WorkItemListItemDto`. The List is un-nested + pre-sorted by the read, so
 * there is no tree metadata to carry. `dueDate` is normalized to a wire-safe
 * ISO string here (matching the tree-node mapper).
 */
export function toWorkItemListItemDto(row: WorkItemListRow): WorkItemListItemDto {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    reporterId: row.reporterId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
  };
}

/**
 * A lazy tree-level row (Subtask 2.5.13) → DTO: the flat-list shape plus the
 * tree-placement fields (`parentId`, `hasChildren`).
 */
export function toWorkItemTreeRowDto(row: WorkItemTreeRow): WorkItemTreeRowDto {
  return {
    ...toWorkItemListItemDto(row),
    parentId: row.parentId,
    hasChildren: row.hasChildren,
  };
}
