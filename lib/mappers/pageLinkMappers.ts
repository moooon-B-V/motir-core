import type { WorkItemPageLinkRowDto } from '@/lib/dto/pageLinks';
import type { WorkItemPageLinkRecord } from '@/lib/repositories/pageWorkItemLinkRepository';

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
