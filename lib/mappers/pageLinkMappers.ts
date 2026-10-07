import type { WorkItemPageLinkRowDto } from '@/lib/dto/pageLinks';
import type { WorkItemPageLinkRecord } from '@/lib/repositories/pageWorkItemLinkRepository';

// The work item's Pages read rows → DTO (Story MOTIR-7565 · MOTIR-7573). The
// folder path is resolved by the service in one batched read and handed in.

export function toWorkItemPageLinkRowDto(
  record: WorkItemPageLinkRecord,
  folderPath: string[],
): WorkItemPageLinkRowDto {
  return {
    pageId: record.pageId,
    title: record.title,
    sources: [...record.sources],
    updatedAt: record.updatedAt.toISOString(),
    place: { folderPath, parentPageTitle: record.parentPageTitle },
  };
}
