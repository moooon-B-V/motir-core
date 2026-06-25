import type { WorkItem } from '@prisma/client';
import type {
  ArchivedWorkItemRow,
  WorkItemForestRow,
  WorkItemListRow,
  WorkItemSubtreeRow,
  WorkItemTreeRow,
} from '@/lib/repositories/workItemRepository';
import type {
  ArchivedWorkItemDto,
  RoadmapNodeDto,
  RoadmapProgressDto,
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
    // Work-item type + executor (Story 2.7) — nullable enums; pass straight
    // through (Prisma enums are plain string unions on the row).
    type: row.type,
    executor: row.executor,
    // The `Decimal(6, 2)` story-point estimate (Story 4.3) → a wire-safe number
    // (or null when unestimated); Decimals don't survive JSON otherwise.
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    position: row.position,
    sprintId: row.sprintId,
    backlogRank: row.backlogRank,
    // Epic-level privacy flag (Story 6.14). Pass the raw boolean through on the
    // INTERNAL DTO; the public PROJECTION (6.14.4) is where it gets stripped /
    // turned into the "children-hidden" marker for a non-member viewer.
    publicChildrenHidden: row.publicChildrenHidden,
    // The integration branch (Story 7.8 · Subtask 7.8.11) — non-null while the
    // item is integrated-awaiting-review; null once it reaches done. Pass through.
    sessionBranch: row.sessionBranch,
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
    estimateMinutes: row.estimateMinutes,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
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
    type: row.type,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    reporterId: row.reporterId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    updatedAt: row.updatedAt.toISOString(),
    depth: row.depth,
    hasChildren: children.length > 0,
    matched: row.matched,
    children,
  };
}

/**
 * Roadmap LEVEL-node DTO (Subtask 7.20.4 re-plan, MOTIR-1010). Maps one
 * `findProjectTreeLevel` row — already carrying the lazy `hasChildren` drill flag —
 * into a flat {@link RoadmapNodeDto}. `isDone` (the node's own done-ness) and
 * `progress` (the subtree done/total roll-up, Subtask 7.20.6 / MOTIR-1013) are the
 * service's call — it holds the project's done-status keys and runs the one extra
 * recursive count over the level's CONTAINERS. `progress` is `null` on a leaf
 * (`!hasChildren`); the service passes it through here.
 */
export function toRoadmapNodeDto(
  row: WorkItemTreeRow,
  isDone: boolean,
  progress: RoadmapProgressDto | null,
): RoadmapNodeDto {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    type: row.type,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    isDone,
    hasChildren: row.hasChildren,
    progress,
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
    type: row.type,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    reporterId: row.reporterId,
    dueDate: row.dueDate ? row.dueDate.toISOString() : null,
    estimateMinutes: row.estimateMinutes,
    storyPoints: row.storyPoints === null ? null : Number(row.storyPoints),
    updatedAt: row.updatedAt.toISOString(),
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

/**
 * An archived-list row (Subtask 2.9.2) → DTO: the flat-list shape plus the
 * archive metadata — the `archivedAt` stamp (ISO-normalized) and the resolved
 * `archivedBy` actor. The actor is `null` when the read found no `'archived'`
 * revision author (the row keeps its archived `id`, the view shows a "former
 * member" fallback).
 */
export function toArchivedWorkItemDto(row: ArchivedWorkItemRow): ArchivedWorkItemDto {
  return {
    ...toWorkItemListItemDto(row),
    archivedAt: row.archivedAt.toISOString(),
    archivedBy: row.archivedById
      ? { id: row.archivedById, name: row.archivedByName, image: row.archivedByImage }
      : null,
  };
}
