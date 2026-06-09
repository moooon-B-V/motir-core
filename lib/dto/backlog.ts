// DTO + input types for the backlog / sprint-association domain (Story 4.1 ·
// Subtask 4.1.4). These are the shapes the Story-4.2 backlog + sprint-planning
// UI binds to. The association/rank WRITES return a `WorkItemDto` (the existing
// work-item shape — the caller already has the mappers for it); the READS
// return the bounded page shape below.

import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

/**
 * One bounded page of ranked issues — the shape BOTH `getBacklog` and
 * `getSprintIssues` return (finding #57: never load-all). `items` are lighter
 * `WorkItemSummaryDto` rows in `backlogRank` order; `nextCursor` is the id to
 * pass back for the next page (null at the end); `totalCount` is the full
 * aggregate count behind the page (the "N issues" header). The cursor walks the
 * whole ordering deterministically — the page never carries the entire set.
 */
export interface RankedIssuePageDto {
  items: WorkItemSummaryDto[];
  nextCursor: string | null;
  totalCount: number;
}

/**
 * A drop position expressed as the two neighbours the moved issue should land
 * BETWEEN, in the rendered order: `beforeId` is the issue that ends up directly
 * ABOVE it, `afterId` the one directly BELOW. Either may be omitted — an absent
 * `beforeId` means "drop at the very top" (prepend), an absent `afterId` means
 * "drop at the very bottom" (append). The service resolves the neighbours' ranks
 * and mints a single fractional-index key strictly between them (one-row write;
 * the same `keyBetween` contract `moveWorkItem` uses for the tree `position`).
 */
export interface RankPlacementInput {
  beforeId?: string;
  afterId?: string;
}
