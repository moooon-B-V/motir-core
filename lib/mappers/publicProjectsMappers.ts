import type { WorkItemKindDto } from '@/lib/dto/workItems';
import type { PublicRequestMatchDto } from '@/lib/dto/publicProjects';
import type { PublicRequestMatchRow } from '@/lib/repositories/workItemRepository';

// Prisma row → DTO conversion for the public-project surfaces (Story 6.12 ·
// Subtask 6.12.5). Keeps the duplicate-detection read from leaking a raw
// work-item row (assignee / estimate / internal fields) across the public
// boundary — only the public-safe identity + demand signal cross.

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
