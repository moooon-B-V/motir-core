import type { Project, WorkItem } from '@prisma/client';
import type { WorkItemKindDto, WorkItemPriorityDto } from '@/lib/dto/workItems';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type {
  PublicProjectLinksDto,
  PublicProjectOverviewDto,
  PublicProjectStatsDto,
  PublicRequestMatchDto,
  PublicWorkItemListItemDto,
} from '@/lib/dto/publicProjects';
import type { PublicRequestMatchRow } from '@/lib/repositories/workItemRepository';

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
 */
export function toPublicWorkItemListItemDto(
  row: Pick<WorkItem, 'id' | 'identifier' | 'key' | 'title' | 'kind' | 'status' | 'priority'>,
  statusCategory: StatusCategoryDto,
): PublicWorkItemListItemDto {
  return {
    id: row.id,
    identifier: row.identifier,
    key: row.key,
    title: row.title,
    kind: row.kind as WorkItemKindDto,
    status: row.status,
    statusCategory,
    priority: row.priority as WorkItemPriorityDto,
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
    name: project.name,
    identifier: project.identifier,
    workspaceName,
    publicOverviewMd: project.publicOverviewMd ?? null,
    stats,
    links: toPublicProjectLinksDto(project),
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
