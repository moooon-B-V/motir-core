import type { Project, WorkItem } from '@prisma/client';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { CommentDTO } from '@/lib/dto/comments';
import type {
  PublicProjectLinksDto,
  PublicProjectOverviewDto,
  PublicProjectStatsDto,
  PublicRequestDetailDto,
  PublicRequestMatchDto,
  PublicRoadmapCardDto,
  PublicWorkItemListItemDto,
  PublicWorkItemTreeRowDto,
} from '@/lib/dto/publicProjects';
import type {
  PublicRequestMatchRow,
  PublicRoadmapRow,
} from '@/lib/repositories/workItemRepository';

// Prisma row → DTO conversion for the public-project surfaces (Story 6.12).
// Both the READ projection (6.12.4) and the duplicate-detection read (6.12.5)
// keep internal fields (assignee / estimate / story points / reporter /
// internal comments) from crossing the public boundary — the DTO shapes don't
// carry them, so a mapper physically cannot emit them. The projection is
// structural, not a runtime omission.

// --- READ projection (6.12.4) ----------------------------------------------

/**
 * Map a work-item row → the public list/board card projection. `statusCategory`
 * is resolved by the caller (it knows the project's workflow) and passed in, so
 * this mapper stays a pure field-selector. The assignee / estimate / story-point
 * columns on `row` are deliberately NOT read — they never enter the DTO.
 *
 * `opts.hideChildren` is the NON-MEMBER flag (Story 6.14 · Subtask 6.14.4): when
 * `true` AND `row` is a PRIVATE epic (`kind = 'epic'`, `publicChildrenHidden`),
 * the card carries the `childrenHidden: true` marker the placeholder UI reads —
 * the epic ROW stays visible while its descendants have already been EXCLUDED
 * server-side from the read. A member viewer (`hideChildren` false) never marks,
 * so a member reads the unchanged projection.
 */
export function toPublicWorkItemListItemDto(
  row: Pick<
    WorkItem,
    'id' | 'identifier' | 'key' | 'title' | 'kind' | 'status' | 'priority' | 'publicChildrenHidden'
  >,
  statusCategory: StatusCategoryDto,
  opts: { hideChildren?: boolean } = {},
): PublicWorkItemListItemDto {
  const dto: PublicWorkItemListItemDto = {
    id: row.id,
    identifier: row.identifier,
    key: row.key,
    title: row.title,
    kind: row.kind as WorkItemKindDto,
    status: row.status,
    statusCategory,
    priority: row.priority as WorkItemPriorityDto,
  };
  if (opts.hideChildren && row.kind === 'epic' && row.publicChildrenHidden) {
    dto.childrenHidden = true;
  }
  return dto;
}

/**
 * Map a public TREE-level row → its DTO (Story 6.14 · Subtask 6.14.10). Reuses
 * {@link toPublicWorkItemListItemDto} for the stripped public projection + the
 * `childrenHidden` marker, then adds the two tree bits (`parentId`,
 * `hasChildren`). The row's internal columns are never read into the DTO — the
 * public boundary stays structural.
 */
export function toPublicWorkItemTreeRowDto(
  row: Pick<
    WorkItem,
    | 'id'
    | 'identifier'
    | 'key'
    | 'title'
    | 'kind'
    | 'status'
    | 'priority'
    | 'publicChildrenHidden'
    | 'parentId'
  > & { hasChildren: boolean },
  statusCategory: StatusCategoryDto,
  opts: { hideChildren?: boolean } = {},
): PublicWorkItemTreeRowDto {
  return {
    ...toPublicWorkItemListItemDto(row, statusCategory, opts),
    parentId: row.parentId,
    hasChildren: row.hasChildren,
  };
}

/**
 * Map a roadmap row → the public roadmap card projection (Subtask 6.12.7). Adds
 * the public `voteCount` (demand signal) + the viewer's `voted` flag to the
 * stripped public projection; the assignee / estimate / story-point columns on
 * `row` are deliberately NOT read. `voted` is coerced to a real boolean (the raw
 * SQL `IS NOT NULL` projection can arrive as a JS boolean already, but the
 * coercion keeps the DTO total).
 */
export function toPublicRoadmapCardDto(row: PublicRoadmapRow): PublicRoadmapCardDto {
  return {
    id: row.id,
    identifier: row.identifier,
    key: row.key,
    title: row.title,
    kind: row.kind as WorkItemKindDto,
    voteCount: row.voteCount,
    voted: Boolean(row.voted),
  };
}

/**
 * Derive the public Links sidebar from EXISTING project fields only — no new
 * schema. Motir's `project` carries no dedicated link columns today, so this
 * returns an empty object until 6.12.8 adds authorable link fields; kept as the
 * single seam so the Overview never hand-rolls link derivation. (When link
 * columns land, read them here.)
 */
export function toPublicProjectLinksDto(_project: Project): PublicProjectLinksDto {
  return {};
}

/**
 * Map a project row + computed stats → the public Overview DTO. `workspaceName`
 * is read by the service (the project row doesn't carry it) and passed in.
 */
export function toPublicProjectOverviewDto(
  project: Project,
  workspaceName: string,
  stats: PublicProjectStatsDto,
): PublicProjectOverviewDto {
  return {
    id: project.id,
    name: project.name,
    identifier: project.identifier,
    workspaceName,
    publicOverviewMd: project.publicOverviewMd ?? null,
    stats,
    links: toPublicProjectLinksDto(project),
  };
}

// --- Request detail (6.12.12) ----------------------------------------------

/**
 * Map a work-item row + the service-resolved extras → the public request DETAIL
 * DTO (Subtask 6.12.12). Like the other public mappers this is a pure field
 * selector: the assignee / estimate / story-point columns on `row` are
 * deliberately NOT read, so an internal field physically cannot enter the
 * detail payload. The status label/category, the upvote tally + viewer flag,
 * the opened-by name, and the already-mapped public `comments` are resolved by
 * the service (it owns the workflow / vote / user / comment reads) and passed
 * in — the mapper just shapes them.
 */
export function toPublicRequestDetailDto(
  row: Pick<
    WorkItem,
    'id' | 'identifier' | 'key' | 'title' | 'kind' | 'status' | 'descriptionMd' | 'createdAt'
  >,
  extras: {
    statusLabel: string;
    statusCategory: StatusCategoryDto;
    openedByName: string;
    voteCount: number;
    voted: boolean;
    comments: CommentDTO[];
  },
): PublicRequestDetailDto {
  return {
    id: row.id,
    identifier: row.identifier,
    key: row.key,
    title: row.title,
    kind: row.kind as WorkItemKindDto,
    status: row.status,
    statusLabel: extras.statusLabel,
    statusCategory: extras.statusCategory,
    descriptionMd: row.descriptionMd ?? null,
    openedByName: extras.openedByName,
    createdAt: row.createdAt.toISOString(),
    voteCount: extras.voteCount,
    voted: extras.voted,
    comments: extras.comments,
  };
}

// --- Duplicate detection (6.12.5) ------------------------------------------

/**
 * Map a duplicate-detection match row to its public DTO — the public-safe
 * subset only (no assignee / estimate / reporter / internal fields), so the
 * dedupe response can never leak an internal field even though it reads the
 * full `work_item` row.
 */
export function toPublicRequestMatchDto(row: PublicRequestMatchRow): PublicRequestMatchDto {
  return {
    id: row.id,
    kind: row.kind as WorkItemKindDto,
    identifier: row.identifier,
    title: row.title,
    status: row.status,
    voteCount: row.voteCount,
  };
}
