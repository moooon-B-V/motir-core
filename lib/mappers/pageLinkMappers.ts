import type { PageWorkItemLinkRowDto, WorkItemPageLinkRowDto } from '@/lib/dto/pageLinks';
import type { WorkItemRefSummaryDto } from '@/lib/dto/workItems';
import type {
  PageManualLinkRecord,
  WorkItemPageLinkRecord,
} from '@/lib/repositories/pageWorkItemLinkRepository';

// The work item's Pages read rows → DTO (Story MOTIR-7565 · MOTIR-7573). The
// folder path is resolved by the service in one batched read and handed in. An
// archived page is served as an `unavailable` row (MOTIR-9203).

export function toWorkItemPageLinkRowDto(
  record: WorkItemPageLinkRecord,
  folderPath: string[],
): WorkItemPageLinkRowDto {
  return {
    pageId: record.pageId,
    title: record.title,
    state: record.archivedAt === null ? 'live' : 'unavailable',
    sources: [...record.sources],
    updatedAt: record.updatedAt.toISOString(),
    place: { folderPath, parentPageTitle: record.parentPageTitle },
  };
}

/** One hand link of a page; `summary` is `null` when the item resolves to nothing (MOTIR-9198). */
export function toPageWorkItemLinkRowDto(
  record: PageManualLinkRecord,
  summary: WorkItemRefSummaryDto | null,
): PageWorkItemLinkRowDto {
  return { workItemId: record.workItemId, linkedAt: record.createdAt.toISOString(), summary };
}
